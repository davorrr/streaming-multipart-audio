export interface ReassemblerOptions {
  /** Index the first release is expected at. Default 0. */
  startIndex?: number;
  /**
   * How many out-of-order items may pile up behind a missing index before the
   * gap is abandoned. Default 8.
   *
   * Without this a single dropped frame stalls playback forever, because the
   * queue waits for an index that will never arrive. Audio would rather skip
   * than stop.
   */
  maxPending?: number;
}

export interface ReassemblerStats {
  /** Items handed back to the caller. */
  released: number;
  /** Items whose index had already been released. */
  late: number;
  /** Items whose index was already pending. */
  duplicates: number;
  /** Indices given up on, either at the `maxPending` limit or on `flush`. */
  skipped: number;
}

/**
 * Restores order to items that carry a monotonically increasing index but may
 * arrive out of order.
 *
 * Frames are synthesised and sent concurrently upstream, so index 3 can land
 * before index 2. Playing them in arrival order plays the sentence in the
 * wrong order. `push` buffers anything early and hands back a contiguous run
 * the moment the gap fills, so the consumer only ever sees the right sequence.
 */
export class ChunkReassembler<T> {
  #next: number;
  #maxPending: number;
  #pending = new Map<number, T>();
  #stats: ReassemblerStats = { released: 0, late: 0, duplicates: 0, skipped: 0 };

  constructor(options: ReassemblerOptions = {}) {
    this.#next = options.startIndex ?? 0;
    this.#maxPending = options.maxPending ?? 8;
    if (this.#maxPending < 1) throw new RangeError('maxPending must be >= 1');
  }

  /** Index the reassembler is currently waiting for. */
  get nextIndex(): number {
    return this.#next;
  }

  /** Items buffered behind a gap. */
  get pending(): number {
    return this.#pending.size;
  }

  get stats(): Readonly<ReassemblerStats> {
    return { ...this.#stats };
  }

  /** Accept one indexed item; return whatever is now releasable, in order. */
  push(index: number, value: T): T[] {
    if (!Number.isInteger(index) || index < 0) {
      throw new RangeError(`index must be a non-negative integer, got ${index}`);
    }
    if (index < this.#next) {
      this.#stats.late++;
      return [];
    }
    if (this.#pending.has(index)) {
      this.#stats.duplicates++;
      return [];
    }

    this.#pending.set(index, value);
    const released = this.#drain();
    if (released.length > 0) return released;

    if (this.#pending.size > this.#maxPending) {
      // Give up on the gap and restart from the earliest index we do hold.
      const earliest = Math.min(...this.#pending.keys());
      this.#stats.skipped += earliest - this.#next;
      this.#next = earliest;
      return this.#drain();
    }
    return [];
  }

  /** Release everything still buffered, in index order, abandoning any gaps. */
  flush(): T[] {
    const indices = [...this.#pending.keys()].sort((a, b) => a - b);
    const out: T[] = [];
    for (const index of indices) {
      this.#stats.skipped += Math.max(0, index - this.#next);
      out.push(this.#pending.get(index)!);
      this.#next = index + 1;
    }
    this.#stats.released += out.length;
    this.#pending.clear();
    return out;
  }

  reset(startIndex = 0): void {
    this.#next = startIndex;
    this.#pending.clear();
    this.#stats = { released: 0, late: 0, duplicates: 0, skipped: 0 };
  }

  #drain(): T[] {
    const out: T[] = [];
    while (this.#pending.has(this.#next)) {
      out.push(this.#pending.get(this.#next)!);
      this.#pending.delete(this.#next);
      this.#next++;
    }
    this.#stats.released += out.length;
    return out;
  }
}
