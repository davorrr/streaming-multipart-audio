/**
 * Demo server: streams a spoken-reply-shaped `multipart/mixed` response.
 *
 * It reproduces the conditions the parser was written for, and lets you dial
 * each one up from the query string:
 *
 *   ?chunks=8      how many audio frames to send
 *   ?shuffle=1     emit frames out of index order (concurrent synthesis)
 *   ?jitter=1      random gaps between frames (variable synthesis latency)
 *   ?split=1       write each frame in random-sized pieces, so header blocks
 *                  and bodies get cut at arbitrary byte offsets
 *   ?drop=3        never send this index at all
 *
 *   npm run demo   →  http://localhost:8080
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

import { SCALE, encodeWav, tone } from './wav.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..'); // dist/example -> repo root
const PUBLIC_DIR = path.join(root, 'example', 'public');
const LIB_DIR = path.join(root, 'dist', 'src');
const BOUNDARY = 'chat';
const PORT = Number(process.env.PORT ?? 8080);

const REPLY = 'Here is a scale, one note per frame, streamed as it is produced.';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

export function createDemoServer(): Server {
  return createServer(handle);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  try {
    if (url.pathname === '/voice') {
      await streamVoice(res, url.searchParams);
      return;
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return await serveFile(res, path.join(PUBLIC_DIR, 'index.html'));
    }
    if (url.pathname === '/app.js') {
      return await serveFile(res, path.join(PUBLIC_DIR, 'app.js'));
    }
    if (url.pathname.startsWith('/lib/')) {
      // Serve the compiled library so the browser can import it directly.
      const rel = url.pathname.slice('/lib/'.length);
      const target = path.join(LIB_DIR, rel);
      if (!target.startsWith(LIB_DIR)) return notFound(res);
      return await serveFile(res, target);
    }
    notFound(res);
  } catch (error) {
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(String(error));
  }
}

async function serveFile(res: ServerResponse, file: string): Promise<void> {
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    notFound(res);
  }
}

function notFound(res: ServerResponse): void {
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
}

async function streamVoice(res: ServerResponse, params: URLSearchParams): Promise<void> {
  const count = clamp(Number(params.get('chunks') ?? 8), 1, SCALE.length);
  const shuffle = params.get('shuffle') === '1';
  const jitter = params.get('jitter') === '1';
  const split = params.get('split') === '1';
  const drop = params.has('drop') ? Number(params.get('drop')) : -1;

  res.writeHead(200, {
    'Content-Type': `multipart/mixed; boundary=${BOUNDARY}`,
    'Cache-Control': 'no-store',
    // Without this, a proxy may buffer the whole reply and defeat the point.
    'X-Accel-Buffering': 'no',
  });

  const write = (chunk: Uint8Array) =>
    new Promise<void>((resolve) => {
      if (!res.write(chunk)) res.once('drain', () => resolve());
      else resolve();
    });

  const writeFrame = async (frame: Uint8Array) => {
    if (!split) return write(frame);
    // Cut the frame at arbitrary offsets so the client sees header blocks and
    // bodies torn across reads — the case the incremental parser exists for.
    let offset = 0;
    while (offset < frame.length) {
      const size = 1 + Math.floor(Math.random() * 400);
      await write(frame.subarray(offset, offset + size));
      offset += size;
      await sleep(2);
    }
  };

  // 1. Metadata first, exactly as the production server did: the transcript is
  //    known before a single sample has been synthesised, so send it and let
  //    the UI render while the audio is still being made.
  await write(
    buildFrame({ 'Content-Type': 'application/json' }, jsonBytes({ transcript: REPLY, response: null })),
  );

  // 2. Audio frames, each a self-contained WAV carrying its true index.
  const indices = [...Array(count).keys()].filter((i) => i !== drop);
  if (shuffle) shuffleInPlace(indices);

  for (const index of indices) {
    if (jitter) await sleep(60 + Math.random() * 260);
    const wav = encodeWav(tone(SCALE[index]!, 0.32));
    await writeFrame(
      buildFrame({ 'Content-Type': 'audio/wav', 'X-Chunk-Index': String(index) }, wav),
    );
    log(`frame ${index}  ${wav.length} B`);
  }

  // 3. Final metadata, then close.
  await write(
    buildFrame({ 'Content-Type': 'application/json' }, jsonBytes({ transcript: null, response: REPLY })),
  );
  res.end(`--${BOUNDARY}--`);
  log(`stream complete (order sent: ${indices.join(', ')})`);
}

function buildFrame(headers: Record<string, string>, body: Uint8Array): Uint8Array {
  const block = Object.entries({ ...headers, 'Content-Length': String(body.length) })
    .map(([k, v]) => `${k}: ${v}\r\n`)
    .join('');
  const head = Buffer.from(`--${BOUNDARY}\r\n${block}\r\n`, 'utf8');
  return Buffer.concat([head, body, Buffer.from('\r\n', 'utf8')]);
}

const jsonBytes = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clamp = (n: number, lo: number, hi: number) =>
  Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.floor(n))) : lo;
let verbose = false;
const log = (message: string) => {
  if (verbose) console.log(`  ${message}`);
};

function shuffleInPlace<T>(items: T[]): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
}

// Only listen when run directly; the CLI demo imports the server instead.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verbose = true;
  createDemoServer().listen(PORT, () => {
    console.log(`\n  streaming-multipart-audio demo → http://localhost:${PORT}\n`);
  });
}
