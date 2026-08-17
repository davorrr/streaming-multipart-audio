/**
 * Headless demo: starts the server, streams a reply over a real socket, and
 * prints what the client saw.
 *
 * The point is the two tables. The wire column is the order frames arrived in;
 * the play column is the order they reached the sink. They differ, and the
 * second one is the one that would have been audible.
 *
 *   npm run demo:cli
 */
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

import { VoiceStreamClient } from '../src/VoiceStreamClient.js';
import { RecordingSink } from '../src/AudioSink.js';
import type { AudioFrame } from '../src/AudioSink.js';
import { createDemoServer } from './server.js';
import { wavDurationSeconds } from './wav.js';

const server = createDemoServer();
server.listen(0);
await once(server, 'listening');
const { port } = server.address() as AddressInfo;

const query = 'chunks=8&shuffle=1&jitter=1&split=1';
const url = `http://127.0.0.1:${port}/voice?${query}`;

console.log(`\n  GET /voice?${query}`);
console.log('  server sends frames out of order, with gaps, cut at random byte offsets\n');

const started = Date.now();
const sink = new RecordingSink();
const client = new VoiceStreamClient({ sink });

const wire: { index: number; atMs: number; bytes: number; heldBack: boolean }[] = [];
let nextExpected = 0;

client.on('part', (part) => {
  const type = part.headers['content-type'] ?? '(none)';
  if (!type.startsWith('audio/')) return;
  const index = Number(part.headers['x-chunk-index']);
  wire.push({
    index,
    atMs: Date.now() - started,
    bytes: part.body.length,
    heldBack: index !== nextExpected,
  });
  if (index === nextExpected) nextExpected++;
});

client.on('metadata', (value) => {
  const { transcript, response } = value as { transcript?: string; response?: string };
  console.log(`  metadata   ${transcript ? `transcript: ${transcript}` : `response: ${response}`}`);
});

client.on('firstAudio', (ms) => console.log(`  first audio ready after ${ms} ms\n`));

const response = await fetch(url);
const stats = await client.consumeResponse(response);

console.log('  arrival order (off the wire)');
console.log('  ─────────────────────────────────────────────');
console.log('   index      at       bytes   parser');
for (const row of wire) {
  console.log(
    `   ${String(row.index).padEnd(6)} ${(row.atMs + ' ms').padStart(8)} ${String(row.bytes).padStart(8)}   ${
      row.heldBack ? 'buffered, out of order' : 'released immediately'
    }`,
  );
}

console.log('\n  play order (what reached the sink)');
console.log('  ─────────────────────────────────────────────');
console.log('   index    duration');
for (const frame of sink.frames as AudioFrame[]) {
  console.log(
    `   ${String(frame.index).padEnd(6)} ${wavDurationSeconds(frame.bytes).toFixed(3)} s`,
  );
}

const wireOrder = wire.map((r) => r.index);
const playOrder = sink.indices;
const sorted = [...playOrder].every((v, i, a) => i === 0 || a[i - 1]! <= v);

console.log(`\n  wire order   ${wireOrder.join(' ')}`);
console.log(`  play order   ${playOrder.join(' ')}   ${sorted ? '✓ in order' : '✗ OUT OF ORDER'}`);
console.log(
  `\n  ${stats.audioFrames} audio frames, ${stats.reordered} arrived early and were buffered, ` +
    `${stats.skipped} skipped`,
);
console.log(
  `  time to first audio ${stats.timeToFirstAudioMs} ms, ` +
    `stream closed cleanly: ${stats.closedCleanly}, ${stats.trailingBytes} bytes left over\n`,
);

server.close();
process.exit(sorted && stats.audioFrames === 8 ? 0 : 1);
