import { VoiceStreamClient, WebAudioSink } from '/lib/index.js';

const $ = (id) => document.getElementById(id);
const playBtn = $('play');
const stopBtn = $('stop');
const rows = $('rows');
const orders = $('orders');
const status = $('status');

let client = null;
let sink = null;

playBtn.addEventListener('click', run);
stopBtn.addEventListener('click', () => {
  client?.stop();
  status.textContent = 'interrupted — playback stopped mid-reply';
  finish();
});

async function run() {
  rows.replaceChildren();
  orders.textContent = '';
  playBtn.disabled = true;
  stopBtn.disabled = false;
  status.textContent = 'streaming…';

  const params = new URLSearchParams({
    chunks: $('chunks').value,
    ...($('shuffle').checked ? { shuffle: '1' } : {}),
    ...($('jitter').checked ? { jitter: '1' } : {}),
    ...($('split').checked ? { split: '1' } : {}),
    ...(Number($('drop').value) >= 0 ? { drop: $('drop').value } : {}),
  });

  const startedAt = performance.now();

  sink = new WebAudioSink({
    onFirstAudio: () => {
      status.textContent = `first audio scheduled ${Math.round(performance.now() - startedAt)} ms in`;
    },
  });

  client = new VoiceStreamClient({ sink, reassemble: $('reassemble').checked });

  const wire = [];
  const played = [];
  let nextExpected = 0;

  client.on('part', (part) => {
    const type = part.headers['content-type'] ?? '';
    if (!type.startsWith('audio/')) return;
    const index = Number(part.headers['x-chunk-index']);
    const heldBack = $('reassemble').checked && index !== nextExpected;
    if (index === nextExpected) nextExpected++;
    wire.push(index);
    addRow(index, Math.round(performance.now() - startedAt), part.body.length, heldBack);
  });

  client.on('audio', (frame) => played.push(frame.index));

  try {
    const response = await fetch(`/voice?${params}`);
    const stats = await client.consumeResponse(response);
    renderOrders(wire, played);
    if (!stats.closedCleanly) status.textContent += ' — stream did not close cleanly';
    else if (stats.skipped) status.textContent += ` — ${stats.skipped} frame(s) skipped`;
  } catch (error) {
    status.textContent = `failed: ${error.message}`;
  } finally {
    finish();
  }
}

function finish() {
  playBtn.disabled = false;
  stopBtn.disabled = true;
}

function addRow(index, atMs, bytes, heldBack) {
  const tr = document.createElement('tr');
  for (const [text, className] of [
    [index, ''],
    [`${atMs} ms`, ''],
    [bytes.toLocaleString(), ''],
    [heldBack ? 'buffered, out of order' : 'released immediately', heldBack ? 'held' : ''],
  ]) {
    const td = document.createElement('td');
    td.textContent = text;
    if (className) td.className = className;
    tr.appendChild(td);
  }
  rows.appendChild(tr);
}

function renderOrders(wire, played) {
  const sorted = played.every((v, i) => i === 0 || played[i - 1] <= v);
  orders.replaceChildren();

  const line = (label, values, cls) => {
    const div = document.createElement('div');
    div.textContent = `${label}  ${values.join(' ')}`;
    if (cls) {
      const span = document.createElement('span');
      span.className = cls;
      span.textContent = cls === 'good' ? '   ✓ in order' : '   ✗ out of order — you heard that';
      div.appendChild(span);
    }
    return div;
  };

  orders.appendChild(line('wire order  ', wire));
  orders.appendChild(line('play order  ', played, sorted ? 'good' : 'bad'));
}
