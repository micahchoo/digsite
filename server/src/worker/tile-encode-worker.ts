// A Bun Worker (a real OS thread) that PNG-encodes one RGBA tile and writes
// it to disk. Spawned by boards/materialise.ts's scatter path — see
// docs/measurements/phase-1-map.md "Row 4 — materialise: root cause":
// composing was CPU work pinned to the one JS thread, so WORKER_CONCURRENCY
// (the job queue's poll concurrency, worker/index.ts) never sped it up,
// however high it was set. This pool moves PNG encoding — the actual CPU
// cost — off that thread; it has nothing to do with the `jobs` table or
// worker/index.ts's polling loop despite living in the same directory.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ImageData, createCanvas } from '@napi-rs/canvas';

type InMsg = {
  path: string;
  width: number;
  height: number;
  rgba: ArrayBuffer;
};

declare const self: Worker;

self.onmessage = (ev: MessageEvent<InMsg>) => {
  const { path, width, height, rgba } = ev.data;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.putImageData(
    new ImageData(new Uint8ClampedArray(rgba), width, height),
    0,
    0,
  );
  const png = canvas.encodeSync('png');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, png);
  postMessage({ done: true });
};
