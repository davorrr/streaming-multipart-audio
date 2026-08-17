/**
 * A growable byte buffer with a read cursor.
 *
 * The parser appends network reads at one end and consumes completed frames at
 * the other. A naive implementation reallocates and copies the whole buffer on
 * every append, which is O(n^2) across a stream whose frames arrive in many
 * small reads. This keeps one contiguous backing array, grows it by doubling,
 * and advances a start offset on consume, so appends and consumes are both
 * amortised O(1) in the bytes actually moved.
 *
 * The live region is always contiguous, so `view()` is a zero-copy subarray and
 * the parser can index into it directly.
 */
export class ByteQueue {
  #buf: Uint8Array;
  #start = 0;
  #end = 0;

  constructor(initialCapacity = 16 * 1024) {
    this.#buf = new Uint8Array(initialCapacity);
  }

  get length(): number {
    return this.#end - this.#start;
  }

  /** Zero-copy view of the unconsumed bytes. Invalidated by the next `push`. */
  view(): Uint8Array {
    return this.#buf.subarray(this.#start, this.#end);
  }

  push(bytes: Uint8Array): void {
    if (bytes.length === 0) return;

    const live = this.length;
    if (this.#end + bytes.length > this.#buf.length) {
      // Reclaiming the consumed prefix is often enough on its own; only grow
      // the allocation when compaction cannot make room.
      if (live + bytes.length <= this.#buf.length) {
        this.#buf.copyWithin(0, this.#start, this.#end);
      } else {
        let capacity = this.#buf.length * 2;
        while (capacity < live + bytes.length) capacity *= 2;
        const next = new Uint8Array(capacity);
        next.set(this.#buf.subarray(this.#start, this.#end), 0);
        this.#buf = next;
      }
      this.#start = 0;
      this.#end = live;
    }

    this.#buf.set(bytes, this.#end);
    this.#end += bytes.length;
  }

  /** Drop `n` bytes from the front. */
  consume(n: number): void {
    this.#start += n;
    if (this.#start >= this.#end) {
      this.#start = 0;
      this.#end = 0;
    }
  }

  /** Copy bytes out of the live region, detaching them from the backing array. */
  slice(from: number, to: number): Uint8Array {
    return this.#buf.slice(this.#start + from, this.#start + to);
  }
}
