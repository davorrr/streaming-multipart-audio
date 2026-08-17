import test from 'node:test';
import assert from 'node:assert/strict';

import { MultipartStreamParser, MultipartParseError } from '../src/MultipartStreamParser.js';
import type { MultipartPart } from '../src/MultipartStreamParser.js';
import {
  BOUNDARY,
  audioFrame,
  bytes,
  closeDelimiter,
  concat,
  frame,
  metadataFrame,
  pseudoBinary,
  splitEvery,
} from './frames.js';

const decode = (u8: Uint8Array) => new TextDecoder().decode(u8);

function parseAll(stream: Uint8Array, chunks: Uint8Array[]): MultipartPart[] {
  void stream;
  const parser = new MultipartStreamParser(BOUNDARY);
  const parts: MultipartPart[] = [];
  for (const chunk of chunks) parts.push(...parser.push(chunk));
  parts.push(...parser.end());
  return parts;
}

test('parses a metadata frame followed by audio frames', () => {
  const stream = concat(
    metadataFrame({ transcript: 'hello', response: null }),
    audioFrame(0, 'AUDIO-ZERO'),
    audioFrame(1, 'AUDIO-ONE'),
    closeDelimiter(),
  );

  const parts = parseAll(stream, [stream]);

  assert.equal(parts.length, 3);
  assert.equal(parts[0]!.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(decode(parts[0]!.body)), { transcript: 'hello', response: null });
  assert.equal(parts[1]!.headers['x-chunk-index'], '0');
  assert.equal(decode(parts[1]!.body), 'AUDIO-ZERO');
  assert.equal(decode(parts[2]!.body), 'AUDIO-ONE');
});

// The property that actually defines an incremental parser: the result must not
// depend on where the network happened to cut the stream. Feeding the same
// bytes split at every possible offset — including one byte at a time — has to
// produce byte-identical output.
test('output is identical for every possible split of the stream', () => {
  const stream = concat(
    metadataFrame({ transcript: 'where do the reads land?' }),
    audioFrame(0, pseudoBinary(300, 7)),
    audioFrame(1, pseudoBinary(64, 11)),
    audioFrame(2, pseudoBinary(1024, 13)),
    closeDelimiter(),
  );

  const expected = parseAll(stream, [stream]);
  assert.equal(expected.length, 4);

  // every two-way split
  for (let cut = 0; cut <= stream.length; cut++) {
    const parts = parseAll(stream, [stream.subarray(0, cut), stream.subarray(cut)]);
    assert.deepEqual(parts, expected, `two-way split at byte ${cut}`);
  }

  // every fixed chunk size, down to one byte at a time
  for (const size of [1, 2, 3, 7, 16, 64, 257, 1024]) {
    const parts = parseAll(stream, splitEvery(stream, size));
    assert.deepEqual(parts, expected, `${size}-byte reads`);
  }
});

// This is the whole reason bodies are length-delimited rather than scanned for.
// A WAV payload can contain any byte sequence, including a byte-perfect copy of
// the delimiter with its CRLF prefix. A scanning parser tears the frame in half
// here; this one does not notice.
test('a body containing a byte-perfect delimiter is preserved intact', () => {
  const trap = concat('\r\n--', BOUNDARY, '\r\nContent-Type: audio/wav\r\n\r\nnot a real frame');
  const body = concat(pseudoBinary(50, 3), trap, pseudoBinary(50, 4));

  const stream = concat(audioFrame(0, body), audioFrame(1, 'after'), closeDelimiter());
  const parts = parseAll(stream, [stream]);

  assert.equal(parts.length, 2);
  assert.deepEqual(parts[0]!.body, body);
  assert.equal(decode(parts[1]!.body), 'after');
});

test('raw delimiter bytes not preceded by CRLF do not start a frame', () => {
  // A preamble containing `--chat` mid-line must not be mistaken for the start.
  const stream = concat(
    `garbage --${BOUNDARY} still garbage`,
    '\r\n',
    audioFrame(0, 'real'),
    closeDelimiter(),
  );

  const parts = parseAll(stream, [stream]);
  assert.equal(parts.length, 1);
  assert.equal(decode(parts[0]!.body), 'real');
});

// Regression: the original scanned with `i < len - 3`, which cannot see a
// terminator whose final byte is the final byte available. A read landing
// exactly on the header/body seam stalled the frame until more bytes arrived,
// and hung outright if none ever did.
test('header terminator landing exactly at the end of a read is detected', () => {
  const stream = concat(audioFrame(0, 'body-bytes'), closeDelimiter());
  const headerEnd = indexOfSubsequence(stream, bytes('\r\n\r\n')) + 4;
  assert.ok(headerEnd > 4);

  const parser = new MultipartStreamParser(BOUNDARY);
  // First read ends precisely after the \r\n\r\n, with no body at all.
  assert.deepEqual(parser.push(stream.subarray(0, headerEnd)), []);
  const parts = parser.push(stream.subarray(headerEnd));
  assert.equal(parts.length, 1);
  assert.equal(decode(parts[0]!.body), 'body-bytes');
  assert.equal(parser.closed, true);
});

test('accepts a closing delimiter with or without a trailing CRLF', () => {
  for (const withCRLF of [true, false]) {
    const stream = concat(audioFrame(0, 'x'), closeDelimiter(withCRLF));
    const parser = new MultipartStreamParser(BOUNDARY);
    const parts = parser.push(stream);
    assert.equal(parts.length, 1, `trailing CRLF: ${withCRLF}`);
    assert.equal(parser.closed, true, `trailing CRLF: ${withCRLF}`);
    assert.equal(parser.buffered, 0);
  }
});

test('end() releases a final frame whose trailing CRLF was omitted', () => {
  const stream = frame({ 'Content-Type': 'audio/wav' }, 'tail', { omitTrailingCRLF: true });

  const parser = new MultipartStreamParser(BOUNDARY);
  assert.deepEqual(parser.push(stream), [], 'held back while the CRLF might still arrive');
  const parts = parser.end();
  assert.equal(parts.length, 1);
  assert.equal(decode(parts[0]!.body), 'tail');
  assert.equal(parser.closed, false, 'no closing delimiter was seen');
});

test('a truncated stream reports itself as unclosed with bytes left over', () => {
  const stream = concat(audioFrame(0, 'complete'), audioFrame(1, 'cut off here'));
  const parser = new MultipartStreamParser(BOUNDARY);
  const parts = [...parser.push(stream.subarray(0, stream.length - 6)), ...parser.end()];

  assert.equal(parts.length, 1);
  assert.equal(parser.closed, false);
  assert.ok(parser.buffered > 0);
});

test('header names are case-insensitive and values may contain colons', () => {
  const stream = concat(
    frame({ 'CONTENT-TYPE': 'audio/wav; codec="opus"', 'X-Trace': 'a:b:c' }, 'v'),
    closeDelimiter(),
  );
  const parts = parseAll(stream, [stream]);
  assert.equal(parts[0]!.headers['content-type'], 'audio/wav; codec="opus"');
  assert.equal(parts[0]!.headers['x-trace'], 'a:b:c');
});

test('a part without Content-Length is rejected', () => {
  const stream = frame({ 'Content-Type': 'audio/wav' }, 'body', { omitContentLength: true });
  const parser = new MultipartStreamParser(BOUNDARY);
  assert.throws(() => parser.push(concat(stream, closeDelimiter())), MultipartParseError);
});

test('a non-numeric Content-Length is rejected', () => {
  const stream = concat(
    `--${BOUNDARY}\r\nContent-Type: audio/wav\r\nContent-Length: soon\r\n\r\nbody\r\n`,
    closeDelimiter(),
  );
  const parser = new MultipartStreamParser(BOUNDARY);
  assert.throws(() => parser.push(stream), /invalid Content-Length/);
});

test('an unterminated header block is bounded rather than buffered forever', () => {
  const parser = new MultipartStreamParser(BOUNDARY, { maxHeaderBytes: 64 });
  const stream = concat(`--${BOUNDARY}\r\n`, 'X-Pad: ' + 'a'.repeat(200));
  assert.throws(() => parser.push(stream), /exceeds 64 bytes/);
});

test('a body not terminated by CRLF mid-stream is rejected', () => {
  const stream = concat(
    `--${BOUNDARY}\r\nContent-Type: audio/wav\r\nContent-Length: 4\r\n\r\nbodyXX`,
    audioFrame(1, 'next'),
  );
  const parser = new MultipartStreamParser(BOUNDARY);
  assert.throws(() => parser.push(stream), /not terminated by CRLF/);
});

test('fromContentType extracts the boundary', () => {
  assert.equal(
    MultipartStreamParser.fromContentType('multipart/mixed; boundary=chat').boundary,
    'chat',
  );
  assert.equal(
    MultipartStreamParser.fromContentType('multipart/mixed; boundary="a b"; charset=utf-8')
      .boundary,
    'a b',
  );
  assert.equal(
    MultipartStreamParser.fromContentType('multipart/mixed;BOUNDARY=Xyz;q=1').boundary,
    'Xyz',
  );
  assert.throws(
    () => MultipartStreamParser.fromContentType('multipart/mixed'),
    MultipartParseError,
  );
});

test('zero-length bodies round-trip', () => {
  const stream = concat(frame({ 'Content-Type': 'audio/wav' }, ''), closeDelimiter());
  const parts = parseAll(stream, [stream]);
  assert.equal(parts.length, 1);
  assert.equal(parts[0]!.body.length, 0);
});

test('frame bodies are detached from the rolling buffer', () => {
  // A body handed out must stay valid once later reads reuse the backing array.
  const stream = concat(audioFrame(0, 'first-body'), audioFrame(1, pseudoBinary(64 * 1024, 5)));
  const parser = new MultipartStreamParser(BOUNDARY);
  const [first] = parser.push(stream);
  assert.ok(first);
  parser.push(closeDelimiter());
  assert.equal(decode(first.body), 'first-body');
});

function indexOfSubsequence(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}
