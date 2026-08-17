export interface AudioFrame {
  /** Value of `X-Chunk-Index`, or a running counter when the header is absent. */
  readonly index: number;
  /** Declared content type, e.g. `audio/wav`. */
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

/**
 * Where ordered audio frames go.
 *
 * The client owns the transport and the ordering; a sink owns playback. Keeping
 * them apart is what lets the transport be tested in Node with no audio stack
 * at all, and it is the seam a non-browser platform plugs into — the React
 * Native build of this pipeline wrote each frame to a cache file and handed it
 * to the platform player, which is a different sink over the identical core.
 */
export interface AudioSink {
  /**
   * Accept one frame. Frames arrive in index order. Implementations that decode
   * asynchronously must preserve that order themselves.
   */
  enqueue(frame: AudioFrame): void | Promise<void>;

  /** Barge-in: drop anything queued and stop what is playing, immediately. */
  stop(): void;
}

/** Sink that records what it was given. Used by the tests and the CLI demo. */
export class RecordingSink implements AudioSink {
  readonly frames: AudioFrame[] = [];
  stopped = false;

  enqueue(frame: AudioFrame): void {
    if (this.stopped) return;
    this.frames.push(frame);
  }

  stop(): void {
    this.stopped = true;
  }

  /** The order frames were actually played in. */
  get indices(): number[] {
    return this.frames.map((f) => f.index);
  }
}
