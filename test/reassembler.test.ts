import test from 'node:test';
import assert from 'node:assert/strict';

import { ChunkReassembler } from '../src/ChunkReassembler.js';

test('in-order arrivals pass straight through', () => {
  const r = new ChunkReassembler<string>();
  assert.deepEqual(r.push(0, 'a'), ['a']);
  assert.deepEqual(r.push(1, 'b'), ['b']);
  assert.deepEqual(r.push(2, 'c'), ['c']);
  assert.equal(r.pending, 0);
  assert.equal(r.stats.released, 3);
});

test('an early arrival is held until the gap fills, then both release in order', () => {
  const r = new ChunkReassembler<string>();
  assert.deepEqual(r.push(0, 'a'), ['a']);
  assert.deepEqual(r.push(2, 'c'), [], 'index 2 must wait for index 1');
  assert.equal(r.pending, 1);
  assert.deepEqual(r.push(1, 'b'), ['b', 'c']);
  assert.equal(r.pending, 0);
});

test('a long out-of-order run releases as one contiguous burst', () => {
  const r = new ChunkReassembler<number>();
  for (const i of [4, 2, 3, 1]) assert.deepEqual(r.push(i, i), []);
  assert.deepEqual(r.push(0, 0), [0, 1, 2, 3, 4]);
});

test('duplicate and late indices are dropped, not replayed', () => {
  const r = new ChunkReassembler<string>();
  r.push(0, 'a');
  assert.deepEqual(r.push(0, 'a-again'), [], 'already released');
  assert.equal(r.stats.late, 1);

  r.push(2, 'c');
  assert.deepEqual(r.push(2, 'c-again'), [], 'already pending');
  assert.equal(r.stats.duplicates, 1);
});

// A dropped frame must not stall audio forever waiting for an index that is
// never coming. Past the limit the gap is abandoned and playback continues.
test('a permanently missing index is abandoned once maxPending is exceeded', () => {
  const r = new ChunkReassembler<number>({ maxPending: 3 });
  // index 0 never arrives
  assert.deepEqual(r.push(1, 1), []);
  assert.deepEqual(r.push(2, 2), []);
  assert.deepEqual(r.push(3, 3), []);
  assert.equal(r.pending, 3);

  assert.deepEqual(r.push(4, 4), [1, 2, 3, 4], 'gap abandoned, buffer drains');
  assert.equal(r.stats.skipped, 1);
  assert.equal(r.nextIndex, 5);
});

test('flush releases the remainder in index order and reports the gaps', () => {
  const r = new ChunkReassembler<number>();
  r.push(0, 0);
  r.push(3, 3);
  r.push(5, 5);
  assert.deepEqual(r.flush(), [3, 5]);
  assert.equal(r.stats.skipped, 3, 'indices 1, 2 and 4 were never seen');
  assert.equal(r.pending, 0);
});

test('a non-zero start index is honoured', () => {
  const r = new ChunkReassembler<string>({ startIndex: 7 });
  assert.deepEqual(r.push(8, 'eight'), []);
  assert.deepEqual(r.push(7, 'seven'), ['seven', 'eight']);
});

test('negative and fractional indices are rejected', () => {
  const r = new ChunkReassembler<string>();
  assert.throws(() => r.push(-1, 'x'), RangeError);
  assert.throws(() => r.push(1.5, 'x'), RangeError);
});

test('reset returns it to a clean state', () => {
  const r = new ChunkReassembler<string>();
  r.push(3, 'c');
  r.reset();
  assert.equal(r.pending, 0);
  assert.equal(r.nextIndex, 0);
  assert.deepEqual(r.stats, { released: 0, late: 0, duplicates: 0, skipped: 0 });
  assert.deepEqual(r.push(0, 'a'), ['a']);
});
