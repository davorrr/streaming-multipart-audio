import { MultipartStreamParser, type MultipartPart } from './MultipartStreamParser.js';
import { ChunkReassembler } from './ChunkReassembler.js';
import type { AudioFrame, AudioSink } from './AudioSink.js';

export interface VoiceStreamOptions {
  /** Where ordered audio frames are delivered. */
  sink: AudioSink;
  /**
   * Restore index order before playing. Default true. Turning it off plays
   * frames in arrival order, which is what the demo uses to make the failure
   * audible.
   */
  reassemble?: boolean;
  /** Frames buffered behind a gap before it is abandoned. Default 8. */
  maxPending?: number;
  maxHeaderBytes?: number;
  /** Injectable clock, so tests can assert timing without waiting. */
  now?: () => number;
}

export interface VoiceStreamStats {
  audioFrames: number;
  metadataFrames: number;
  /** Parts with a content type the client does not handle. */
  ignoredFrames: number;
  /** Metadata frames whose body was not valid JSON. */
  malformedMetadata: number;
  /** Frames buffered out of order and released later. */
  reordered: number;
  /** Indices given up on. */
  skipped: number;
  /** Milliseconds from the first byte to the first audio frame reaching the sink. */
  timeToFirstAudioMs: number | null;
  /** True if the stream ended with a `--boundary--` delimiter. */
  closedCleanly: boolean;
  /** Bytes still buffered when the stream ended. Non-zero means truncated. */
  trailingBytes: number;
}

type Listener<A extends unknown[]> = (...args: A) => void;
// The store is heterogeneous by construction; `on`/`off`/`emit` are the typed door.
type AnyListener = (...args: never[]) => void;

interface EventMap {
  metadata: [value: unknown, part: MultipartPart];
  audio: [frame: AudioFrame];
  firstAudio: [elapsedMs: number];
  part: [part: MultipartPart];
  end: [stats: VoiceStreamStats];
}

/**
 * Drives one streamed reply: parse frames off the wire, put the audio back in
 * order, hand it to a sink, and support cutting it off mid-sentence.
 */
export class VoiceStreamClient {
  #sink: AudioSink;
  #reassembler: ChunkReassembler<AudioFrame> | null;
  #maxHeaderBytes?: number;
  #now: () => number;

  #listeners = new Map<keyof EventMap, Set<AnyListener>>();
  #fallbackIndex = 0;
  #startedAt: number | null = null;
  #firstAudioAt: number | null = null;
  #aborted = false;
  #pendingSink: Promise<void>[] = [];

  #counts = {
    audioFrames: 0,
    metadataFrames: 0,
    ignoredFrames: 0,
    malformedMetadata: 0,
    reordered: 0,
  };
  #closedCleanly = false;
  #trailingBytes = 0;

  constructor(options: VoiceStreamOptions) {
    this.#sink = options.sink;
    this.#reassembler =
      options.reassemble === false
        ? null
        : new ChunkReassembler<AudioFrame>({ maxPending: options.maxPending });
    this.#maxHeaderBytes = options.maxHeaderBytes;
    this.#now = options.now ?? (() => Date.now());
  }

  on<E extends keyof EventMap>(event: E, listener: Listener<EventMap[E]>): this {
    let set = this.#listeners.get(event);
    if (!set) this.#listeners.set(event, (set = new Set()));
    set.add(listener as unknown as AnyListener);
    return this;
  }

  off<E extends keyof EventMap>(event: E, listener: Listener<EventMap[E]>): this {
    this.#listeners.get(event)?.delete(listener as unknown as AnyListener);
    return this;
  }

  /** Consume a response whose `Content-Type` carries the boundary. */
  async consumeResponse(response: Response): Promise<VoiceStreamStats> {
    const contentType = response.headers.get('content-type') ?? '';
    if (!response.body) throw new Error('response has no body to stream');
    const parser = MultipartStreamParser.fromContentType(contentType, {
      maxHeaderBytes: this.#maxHeaderBytes,
    });
    return this.consume(response.body, parser);
  }

  /**
   * Consume a byte source. Resolves once the stream ends, or once `stop()` has
   * cut it short.
   */
  async consume(
    source: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
    parser: MultipartStreamParser | string,
  ): Promise<VoiceStreamStats> {
    const p =
      typeof parser === 'string'
        ? new MultipartStreamParser(parser, { maxHeaderBytes: this.#maxHeaderBytes })
        : parser;

    this.#startedAt = this.#now();
    this.#aborted = false;

    try {
      for await (const chunk of toAsyncIterable(source)) {
        if (this.#aborted) break;
        for (const part of p.push(chunk)) this.#handlePart(part);
      }
      if (!this.#aborted) {
        for (const part of p.end()) this.#handlePart(part);
        // Anything still held behind a gap will never be filled now.
        if (this.#reassembler) {
          for (const frame of this.#reassembler.flush()) this.#deliver(frame);
        }
      }
    } finally {
      this.#closedCleanly = p.closed;
      this.#trailingBytes = p.buffered;
      await Promise.allSettled(this.#pendingSink);
      this.#pendingSink = [];
    }

    const stats = this.stats;
    this.#emit('end', stats);
    return stats;
  }

  /** Barge-in: stop reading and silence the sink. */
  stop(): void {
    this.#aborted = true;
    this.#sink.stop();
  }

  get stats(): VoiceStreamStats {
    return {
      ...this.#counts,
      skipped: this.#reassembler?.stats.skipped ?? 0,
      timeToFirstAudioMs:
        this.#firstAudioAt !== null && this.#startedAt !== null
          ? this.#firstAudioAt - this.#startedAt
          : null,
      closedCleanly: this.#closedCleanly,
      trailingBytes: this.#trailingBytes,
    };
  }

  #handlePart(part: MultipartPart): void {
    this.#emit('part', part);
    // The original indexed this header unguarded and threw on any part that
    // omitted it.
    const contentType = part.headers['content-type'] ?? '';

    if (contentType.startsWith('application/json')) {
      const text = new TextDecoder().decode(part.body).trim();
      if (!text) return;
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        this.#counts.malformedMetadata++;
        return; // a bad metadata frame must not take the audio down with it
      }
      this.#counts.metadataFrames++;
      this.#emit('metadata', value, part);
      return;
    }

    if (contentType.startsWith('audio/')) {
      const raw = part.headers['x-chunk-index'];
      const parsed = raw === undefined ? Number.NaN : Number(raw);
      const index = Number.isInteger(parsed) && parsed >= 0 ? parsed : this.#fallbackIndex++;
      if (Number.isInteger(parsed) && parsed >= 0) this.#fallbackIndex = index + 1;

      const frame: AudioFrame = { index, contentType, bytes: part.body };
      this.#counts.audioFrames++;

      if (this.#reassembler) {
        if (index !== this.#reassembler.nextIndex) this.#counts.reordered++;
        for (const ready of this.#reassembler.push(index, frame)) this.#deliver(ready);
      } else {
        this.#deliver(frame);
      }
      return;
    }

    this.#counts.ignoredFrames++;
  }

  #deliver(frame: AudioFrame): void {
    if (this.#aborted) return;
    if (this.#firstAudioAt === null) {
      this.#firstAudioAt = this.#now();
      this.#emit('firstAudio', this.#firstAudioAt - (this.#startedAt ?? this.#firstAudioAt));
    }
    this.#emit('audio', frame);
    const result = this.#sink.enqueue(frame);
    if (result) this.#pendingSink.push(result);
  }

  #emit<E extends keyof EventMap>(event: E, ...args: EventMap[E]): void {
    const set = this.#listeners.get(event);
    if (!set) return;
    for (const listener of set) (listener as unknown as Listener<EventMap[E]>)(...args);
  }
}

function toAsyncIterable(
  source: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
): AsyncIterable<Uint8Array> {
  if (Symbol.asyncIterator in source) return source as AsyncIterable<Uint8Array>;

  // Older browsers do not implement async iteration on ReadableStream.
  const stream = source as ReadableStream<Uint8Array>;
  return {
    async *[Symbol.asyncIterator]() {
      const reader = stream.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          if (value) yield value;
        }
      } finally {
        reader.releaseLock();
      }
    },
  };
}
