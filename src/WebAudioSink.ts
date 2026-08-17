import type { AudioFrame, AudioSink } from './AudioSink.js';

export interface WebAudioSinkOptions {
  /** Reuse an existing context. One is created lazily otherwise. */
  context?: AudioContext;
  /** Node to connect to. Defaults to `context.destination`. */
  destination?: AudioNode;
  /**
   * Seconds of headroom when scheduling the first frame, absorbing decode
   * jitter so playback does not start behind the clock. Default 0.05.
   */
  leadTime?: number;
  /** Fired when the first frame is actually scheduled to sound. */
  onFirstAudio?: () => void;
  /** Fired when the queue drains. */
  onDrained?: () => void;
}

/**
 * Gapless Web Audio playback of a stream of encoded audio frames.
 *
 * Scheduling is absolute, not reactive. Each frame is started at an explicit
 * time on the audio clock — the running end of the previous one — so the next
 * buffer is already queued in the audio thread before the current one finishes.
 *
 * The obvious alternative, starting the next frame from the previous one's
 * `onended` callback, was what the original did, and it is not gapless: the
 * event has to cross into the main thread, wait its turn in the event loop, and
 * only then start the source. At sentence-sized frames that lands as an audible
 * stutter between every chunk.
 *
 * Decoding is asynchronous, so `enqueue` serialises onto a promise chain.
 * Without it, a short frame that decodes quickly could be scheduled ahead of a
 * long one that arrived before it.
 */
export class WebAudioSink implements AudioSink {
  #context: AudioContext | null;
  #destination: AudioNode | null = null;
  #leadTime: number;
  #onFirstAudio?: () => void;
  #onDrained?: () => void;

  /** End of the scheduled audio, on the context clock. */
  #playhead = 0;
  #live = new Set<AudioBufferSourceNode>();
  #chain: Promise<void> = Promise.resolve();
  #generation = 0;
  #startedSounding = false;

  constructor(options: WebAudioSinkOptions = {}) {
    this.#context = options.context ?? null;
    if (options.destination) this.#destination = options.destination;
    this.#leadTime = options.leadTime ?? 0.05;
    this.#onFirstAudio = options.onFirstAudio;
    this.#onDrained = options.onDrained;
  }

  get context(): AudioContext {
    if (!this.#context) {
      const Ctor =
        globalThis.AudioContext ??
        (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) throw new Error('Web Audio is not available in this environment');
      this.#context = new Ctor();
    }
    return this.#context;
  }

  enqueue(frame: AudioFrame): Promise<void> {
    const generation = this.#generation;
    this.#chain = this.#chain.then(() => this.#schedule(frame, generation)).catch(() => {});
    return this.#chain;
  }

  async #schedule(frame: AudioFrame, generation: number): Promise<void> {
    if (generation !== this.#generation) return; // stopped while queued
    const context = this.context;
    if (context.state === 'suspended') await context.resume();

    // decodeAudioData detaches the buffer it is given, so hand it a copy.
    const encoded = frame.bytes.slice().buffer;
    const decoded = await context.decodeAudioData(encoded as ArrayBuffer);
    if (generation !== this.#generation) return; // stopped mid-decode

    const source = context.createBufferSource();
    source.buffer = decoded;
    source.connect(this.#destination ?? context.destination);

    const startAt = Math.max(context.currentTime + this.#leadTime, this.#playhead);
    source.start(startAt);
    this.#playhead = startAt + decoded.duration;

    this.#live.add(source);
    source.onended = () => {
      this.#live.delete(source);
      if (this.#live.size === 0 && generation === this.#generation) this.#onDrained?.();
    };

    if (!this.#startedSounding) {
      this.#startedSounding = true;
      this.#onFirstAudio?.();
    }
  }

  /**
   * Barge-in. Stops every scheduled source and invalidates work still in the
   * decode chain.
   *
   * Deliberately does not close the AudioContext. Closing it discards the
   * unlock earned from the user gesture that started playback, and on iOS the
   * next reply is then silent until the user taps again — a bug the original
   * shipped with.
   */
  stop(): void {
    this.#generation++;
    for (const source of this.#live) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // already stopped
      }
    }
    this.#live.clear();
    this.#playhead = 0;
    this.#startedSounding = false;
    this.#chain = Promise.resolve();
  }

  /** Release the audio hardware. Call on teardown, not on barge-in. */
  async close(): Promise<void> {
    this.stop();
    if (this.#context && this.#context.state !== 'closed') await this.#context.close();
    this.#context = null;
  }
}
