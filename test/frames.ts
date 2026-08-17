/** Builders for the wire format the tests parse. */

const enc = new TextEncoder();

export const BOUNDARY = 'chat';

export function bytes(value: string | Uint8Array): Uint8Array {
  return typeof value === 'string' ? enc.encode(value) : value;
}

export function concat(...parts: (string | Uint8Array)[]): Uint8Array {
  const chunks = parts.map(bytes);
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export interface FrameOptions {
  boundary?: string;
  /** Omit the auto-computed Content-Length header. */
  omitContentLength?: boolean;
  /** Omit the CRLF that terminates the body. */
  omitTrailingCRLF?: boolean;
}

export function frame(
  headers: Record<string, string>,
  body: string | Uint8Array,
  options: FrameOptions = {},
): Uint8Array {
  const boundary = options.boundary ?? BOUNDARY;
  const bodyBytes = bytes(body);
  const all: Record<string, string> = { ...headers };
  if (!options.omitContentLength) all['Content-Length'] = String(bodyBytes.length);

  const headerBlock = Object.entries(all)
    .map(([k, v]) => `${k}: ${v}\r\n`)
    .join('');

  return concat(
    `--${boundary}\r\n${headerBlock}\r\n`,
    bodyBytes,
    options.omitTrailingCRLF ? new Uint8Array(0) : bytes('\r\n'),
  );
}

export function metadataFrame(value: unknown, options: FrameOptions = {}): Uint8Array {
  return frame({ 'Content-Type': 'application/json' }, JSON.stringify(value), options);
}

export function audioFrame(
  index: number,
  body: string | Uint8Array,
  options: FrameOptions = {},
): Uint8Array {
  return frame(
    { 'Content-Type': 'audio/wav', 'X-Chunk-Index': String(index) },
    body,
    options,
  );
}

export function closeDelimiter(withTrailingCRLF = true, boundary = BOUNDARY): Uint8Array {
  return bytes(`--${boundary}--${withTrailingCRLF ? '\r\n' : ''}`);
}

/** Deterministic pseudo-binary payload, so tests are reproducible. */
export function pseudoBinary(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed;
  for (let i = 0; i < length; i++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    out[i] = (state >>> 16) & 0xff;
  }
  return out;
}

/** Every way of cutting `data` into `count` consecutive pieces is impractical;
 *  this yields the `count`-way even split plus the single-byte extreme. */
export function splitEvery(data: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < data.length; i += size) out.push(data.subarray(i, i + size));
  return out;
}
