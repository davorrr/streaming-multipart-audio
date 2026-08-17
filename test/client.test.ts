import test from 'node:test';
import assert from 'node:assert/strict';

import { VoiceStreamClient } from '../src/VoiceStreamClient.js';
import { RecordingSink } from '../src/AudioSink.js';
import { BOUNDARY, audioFrame, closeDelimiter, concat, frame, metadataFrame } from './frames.js';

const decode = (u8: Uint8Array) => new TextDecoder().decode(u8);

async function* reads(data: Uint8Array, size = 13): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < data.length; i += size) {
    yield data.subarray(i, i + size);
    await Promise.resolve(); // let the client's loop interleave
  }
}

test('audio arriving out of order is played in index order', async () => {
  const sink = new RecordingSink();
  const client = new VoiceStreamClient({ sink });

  // The wire order is scrambled; each frame still carries its true index.
  const stream = concat(
    metadataFrame({ transcript: 'say something' }),
    audioFrame(2, 'third'),
    audioFrame(0, 'first'),
    audioFrame(3, 'fourth'),
    audioFrame(1, 'second'),
    closeDelimiter(),
  );

  const stats = await client.consume(reads(stream), BOUNDARY);

  assert.deepEqual(sink.indices, [0, 1, 2, 3]);
  assert.deepEqual(
    sink.frames.map((f) => decode(f.bytes)),
    ['first', 'second', 'third', 'fourth'],
  );
  assert.equal(stats.audioFrames, 4);
  assert.equal(stats.metadataFrames, 1);
  assert.equal(stats.closedCleanly, true);
  assert.equal(stats.trailingBytes, 0);
  assert.ok(stats.reordered > 0);
});

test('with reassembly off, the same stream plays in the wrong order', async () => {
  const sink = new RecordingSink();
  const client = new VoiceStreamClient({ sink, reassemble: false });

  const stream = concat(
    audioFrame(2, 'third'),
    audioFrame(0, 'first'),
    audioFrame(1, 'second'),
    closeDelimiter(),
  );

  await client.consume(reads(stream), BOUNDARY);
  assert.deepEqual(sink.indices, [2, 0, 1]);
});

test('metadata frames are decoded and emitted', async () => {
  const sink = new RecordingSink();
  const client = new VoiceStreamClient({ sink });
  const seen: unknown[] = [];
  client.on('metadata', (value) => seen.push(value));

  const stream = concat(
    metadataFrame({ transcript: 'hello', response: null }),
    audioFrame(0, 'a'),
    metadataFrame({ transcript: null, response: 'hi there' }),
    closeDelimiter(),
  );

  await client.consume(reads(stream), BOUNDARY);
  assert.deepEqual(seen, [
    { transcript: 'hello', response: null },
    { transcript: null, response: 'hi there' },
  ]);
});

// The original indexed headers["content-type"] with no guard, so any part that
// omitted the header threw and took the whole stream down with it.
test('a part with no Content-Type is ignored rather than fatal', async () => {
  const sink = new RecordingSink();
  const client = new VoiceStreamClient({ sink });

  const stream = concat(
    frame({ 'X-Note': 'no content type here' }, 'mystery'),
    audioFrame(0, 'audio'),
    closeDelimiter(),
  );

  const stats = await client.consume(reads(stream), BOUNDARY);
  assert.equal(stats.ignoredFrames, 1);
  assert.deepEqual(sink.indices, [0]);
});

test('malformed metadata does not take the audio down with it', async () => {
  const sink = new RecordingSink();
  const client = new VoiceStreamClient({ sink });

  const stream = concat(
    frame({ 'Content-Type': 'application/json' }, '{not json'),
    audioFrame(0, 'audio'),
    closeDelimiter(),
  );

  const stats = await client.consume(reads(stream), BOUNDARY);
  assert.equal(stats.malformedMetadata, 1);
  assert.equal(stats.metadataFrames, 0);
  assert.deepEqual(sink.indices, [0]);
});

// The web original tested startsWith("audio/wav") with no else branch, so every
// frame from the endpoint that happened to encode as AAC fell through both
// branches and was discarded without a word. The text still rendered; the reply
// was simply silent.
test('audio frames are accepted whatever the audio subtype is', async () => {
  const sink = new RecordingSink();
  const client = new VoiceStreamClient({ sink });

  const stream = concat(
    frame({ 'Content-Type': 'audio/aac', 'X-Chunk-Index': '0' }, 'aac-body'),
    frame({ 'Content-Type': 'audio/mpeg', 'X-Chunk-Index': '1' }, 'mpeg-body'),
    frame({ 'Content-Type': 'audio/wav; codec=pcm', 'X-Chunk-Index': '2' }, 'wav-body'),
    closeDelimiter(),
  );

  const stats = await client.consume(reads(stream), BOUNDARY);

  assert.deepEqual(sink.indices, [0, 1, 2]);
  assert.equal(stats.ignoredFrames, 0, 'nothing may be silently discarded');
  assert.deepEqual(
    sink.frames.map((f) => f.contentType),
    ['audio/aac', 'audio/mpeg', 'audio/wav; codec=pcm'],
  );
});

test('frames without X-Chunk-Index fall back to arrival order', async () => {
  const sink = new RecordingSink();
  const client = new VoiceStreamClient({ sink });

  const stream = concat(
    frame({ 'Content-Type': 'audio/wav' }, 'one'),
    frame({ 'Content-Type': 'audio/wav' }, 'two'),
    closeDelimiter(),
  );

  await client.consume(reads(stream), BOUNDARY);
  assert.deepEqual(sink.indices, [0, 1]);
  assert.deepEqual(
    sink.frames.map((f) => decode(f.bytes)),
    ['one', 'two'],
  );
});

test('barge-in stops delivery mid-stream', async () => {
  const sink = new RecordingSink();
  const client = new VoiceStreamClient({ sink });

  client.on('audio', (f) => {
    if (f.index === 1) client.stop();
  });

  const stream = concat(
    audioFrame(0, 'a'),
    audioFrame(1, 'b'),
    audioFrame(2, 'c'),
    audioFrame(3, 'd'),
    closeDelimiter(),
  );

  await client.consume(reads(stream, 4), BOUNDARY);

  // Barge-in means silence now: the frame being dispatched when the interrupt
  // lands is dropped along with everything behind it.
  assert.deepEqual(sink.indices, [0]);
  assert.equal(sink.stopped, true);
});

test('time to first audio is measured from the first byte', async () => {
  let clock = 1_000;
  const sink = new RecordingSink();
  const client = new VoiceStreamClient({ sink, now: () => clock });

  const firstAudio: number[] = [];
  client.on('firstAudio', (ms) => firstAudio.push(ms));

  // A long metadata-only prelude before the first audio frame.
  const prelude = metadataFrame({ transcript: 'thinking' });
  const stream = concat(prelude, audioFrame(0, 'a'), audioFrame(1, 'b'), closeDelimiter());

  const source = (async function* () {
    yield stream.subarray(0, prelude.length);
    clock += 250; // 250 ms of silence before audio starts
    yield stream.subarray(prelude.length);
  })();

  const stats = await client.consume(source, BOUNDARY);
  assert.equal(stats.timeToFirstAudioMs, 250);
  assert.deepEqual(firstAudio, [250], 'fires once, on the first frame only');
});

test('a dropped index is abandoned so playback continues', async () => {
  const sink = new RecordingSink();
  const client = new VoiceStreamClient({ sink, maxPending: 2 });

  // index 1 is never sent
  const stream = concat(
    audioFrame(0, 'a'),
    audioFrame(2, 'c'),
    audioFrame(3, 'd'),
    audioFrame(4, 'e'),
    closeDelimiter(),
  );

  const stats = await client.consume(reads(stream), BOUNDARY);
  assert.deepEqual(sink.indices, [0, 2, 3, 4]);
  assert.equal(stats.skipped, 1);
});

test('frames still buffered when the stream ends are flushed, not lost', async () => {
  const sink = new RecordingSink();
  const client = new VoiceStreamClient({ sink });

  // index 1 never arrives and the stream simply ends.
  const stream = concat(audioFrame(0, 'a'), audioFrame(2, 'c'), closeDelimiter());

  await client.consume(reads(stream), BOUNDARY);
  assert.deepEqual(sink.indices, [0, 2]);
});

test('consumeResponse takes the boundary from the Content-Type header', async () => {
  const sink = new RecordingSink();
  const client = new VoiceStreamClient({ sink });

  const stream = concat(audioFrame(0, 'a'), audioFrame(1, 'b'), closeDelimiter());
  const response = new Response(new Blob([stream as BlobPart]).stream(), {
    headers: { 'Content-Type': `multipart/mixed; boundary=${BOUNDARY}` },
  });

  const stats = await client.consumeResponse(response);
  assert.deepEqual(sink.indices, [0, 1]);
  assert.equal(stats.closedCleanly, true);
});
