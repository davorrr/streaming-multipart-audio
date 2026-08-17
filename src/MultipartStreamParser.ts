import { ByteQueue } from './ByteQueue.js';

const CR = 13;
const LF = 10;
const DASH = 45;

export interface MultipartPart {
  /** Header names lower-cased. On a repeated name, the last value wins. */
  readonly headers: Readonly<Record<string, string>>;
  /** Frame body, copied out of the rolling buffer so it can be retained. */
  readonly body: Uint8Array;
}

export interface ParserOptions {
  /**
   * Cap on a single header block. Bounds the scan for the `\r\n\r\n`
   * terminator while a body is still arriving, and stops a stream that never
   * sends one from buffering without limit. Default 8 KiB.
   */
  maxHeaderBytes?: number;
}

export class MultipartParseError extends Error {
  override readonly name = 'MultipartParseError';
}

/**
 * Incremental parser for a length-delimited `multipart/mixed` stream.
 *
 * Feed it bytes as they arrive; it returns whole frames and keeps the
 * remainder buffered. A frame is only returned once its header block AND the
 * full `Content-Length` body have arrived, so callers never see a torn frame.
 *
 * Two rules make it binary-safe, which matters because the bodies here are
 * audio and can contain anything:
 *
 *  1. A delimiter is only recognised at the start of the stream or immediately
 *     after a CRLF. Raw `--boundary` bytes inside a payload do not match.
 *  2. After the first delimiter, the parser is anchored: every subsequent frame
 *     is located by `Content-Length` arithmetic, never by scanning for the next
 *     delimiter. A body may contain a byte-perfect copy of the delimiter,
 *     CRLF prefix included, and it is still just body.
 *
 * Rule 2 is why `Content-Length` is required on every part. RFC 2046 multipart
 * is delimiter-scanned and therefore needs the delimiter to be unguessable;
 * this profile is length-delimited, which is both safer and O(1) per frame.
 */
export class MultipartStreamParser {
  readonly boundary: string;

  #delimiter: Uint8Array;
  #queue = new ByteQueue();
  #decoder = new TextDecoder();
  #maxHeaderBytes: number;
  #anchored = false;
  #closed = false;

  constructor(boundary: string, options: ParserOptions = {}) {
    if (!boundary) throw new MultipartParseError('boundary must be a non-empty string');
    this.boundary = boundary;
    this.#delimiter = new TextEncoder().encode(`--${boundary}`);
    this.#maxHeaderBytes = options.maxHeaderBytes ?? 8192;
  }

  /**
   * Build a parser from a `Content-Type` response header, e.g.
   * `multipart/mixed; boundary=chat`. Handles a quoted boundary and trailing
   * parameters.
   */
  static fromContentType(contentType: string, options?: ParserOptions): MultipartStreamParser {
    const match = /;\s*boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(contentType ?? '');
    const boundary = match?.[1] ?? match?.[2];
    if (!boundary) {
      throw new MultipartParseError(`no boundary parameter in Content-Type: ${contentType}`);
    }
    return new MultipartStreamParser(boundary, options);
  }

  /** True once the closing `--boundary--` delimiter has been seen. */
  get closed(): boolean {
    return this.#closed;
  }

  /** Bytes held back waiting for the rest of a frame. */
  get buffered(): number {
    return this.#queue.length;
  }

  /** Append bytes and return every frame that is now complete. */
  push(bytes: Uint8Array): MultipartPart[] {
    this.#queue.push(bytes);
    return this.#drain(false);
  }

  /**
   * Signal end of stream and return any frame that is complete apart from its
   * trailing CRLF — a real server sometimes omits it on the last frame.
   * Inspect `closed` and `buffered` afterwards to tell a clean end from a
   * truncated one.
   */
  end(): MultipartPart[] {
    return this.#drain(true);
  }

  #drain(atEnd: boolean): MultipartPart[] {
    const parts: MultipartPart[] = [];
    for (;;) {
      const part = this.#next(atEnd);
      if (!part) return parts;
      parts.push(part);
    }
  }

  #next(atEnd: boolean): MultipartPart | null {
    if (this.#closed) return null;

    let buf = this.#queue.view();

    if (!this.#anchored) {
      const at = findDelimiter(buf, this.#delimiter);
      if (at === -1) return null;
      if (at > 0) {
        this.#queue.consume(at); // discard any preamble
        buf = this.#queue.view();
      }
      this.#anchored = true;
    }

    // Two bytes past the delimiter tell us whether this is another frame
    // (CRLF) or the end of the stream (`--`).
    const n = this.#delimiter.length;
    if (buf.length < n + 2) return null;
    if (!startsWith(buf, this.#delimiter)) {
      throw new MultipartParseError('stream is not positioned at a delimiter');
    }

    if (buf[n] === DASH && buf[n + 1] === DASH) {
      this.#closed = true;
      let consumed = n + 2;
      if (buf[consumed] === CR && buf[consumed + 1] === LF) consumed += 2;
      this.#queue.consume(consumed);
      return null;
    }

    if (buf[n] !== CR || buf[n + 1] !== LF) {
      throw new MultipartParseError('delimiter is followed by neither CRLF nor "--"');
    }

    const headerStart = n + 2;
    const scanLimit = Math.min(buf.length, headerStart + this.#maxHeaderBytes + 4);
    const headerEnd = findDoubleCRLF(buf, headerStart, scanLimit);
    if (headerEnd === -1) {
      if (scanLimit - headerStart > this.#maxHeaderBytes) {
        throw new MultipartParseError(`header block exceeds ${this.#maxHeaderBytes} bytes`);
      }
      return null; // header block still arriving
    }

    const headers = parseHeaders(this.#decoder.decode(buf.subarray(headerStart, headerEnd)));

    const rawLength = headers['content-length'];
    if (rawLength === undefined) {
      throw new MultipartParseError('part is missing a Content-Length header');
    }
    const bodyLength = Number(rawLength);
    if (!Number.isInteger(bodyLength) || bodyLength < 0) {
      throw new MultipartParseError(`invalid Content-Length: ${rawLength}`);
    }

    const bodyStart = headerEnd + 4; // skip the \r\n\r\n
    const bodyEnd = bodyStart + bodyLength;

    if (buf.length < bodyEnd) return null; // body still arriving

    let consumed: number;
    if (buf.length >= bodyEnd + 2 && buf[bodyEnd] === CR && buf[bodyEnd + 1] === LF) {
      consumed = bodyEnd + 2;
    } else if (atEnd) {
      consumed = bodyEnd; // last frame, trailing CRLF omitted
    } else if (buf.length < bodyEnd + 2) {
      return null; // trailing CRLF still arriving
    } else {
      throw new MultipartParseError('part body is not terminated by CRLF');
    }

    const body = this.#queue.slice(bodyStart, bodyEnd);
    this.#queue.consume(consumed);
    return { headers, body };
  }
}

/**
 * First delimiter that sits at offset 0 or directly after a CRLF.
 *
 * Only used once, to synchronise with the stream. After that the parser is
 * anchored and locates frames arithmetically.
 */
function findDelimiter(buf: Uint8Array, delimiter: Uint8Array): number {
  outer: for (let i = 0; i + delimiter.length <= buf.length; i++) {
    if (buf[i] !== DASH) continue;
    if (i !== 0 && !(buf[i - 2] === CR && buf[i - 1] === LF)) continue;
    for (let j = 1; j < delimiter.length; j++) {
      if (buf[i + j] !== delimiter[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/**
 * Index of the `\r\n\r\n` that ends a header block, searched in `[from, limit)`.
 *
 * The bound is `i + 3 < limit`, not `i < limit - 3`: the latter misses a
 * terminator whose last byte is the last byte available, which is exactly what
 * happens when a network read lands on the header/body seam.
 */
function findDoubleCRLF(buf: Uint8Array, from: number, limit: number): number {
  for (let i = from; i + 3 < limit; i++) {
    if (buf[i] === CR && buf[i + 1] === LF && buf[i + 2] === CR && buf[i + 3] === LF) {
      return i;
    }
  }
  return -1;
}

function startsWith(buf: Uint8Array, prefix: Uint8Array): boolean {
  if (buf.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (buf[i] !== prefix[i]) return false;
  }
  return true;
}

function parseHeaders(block: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of block.split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return headers;
}
