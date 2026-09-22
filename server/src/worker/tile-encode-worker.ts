// A Bun Worker (a real OS thread) that PNG-encodes one RGBA tile. Spawned
// by boards/materialise.ts's scatter path — see docs/measurements/
// phase-1-map.md "Row 4 — materialise: root cause": composing was CPU work
// pinned to the one JS thread, so WORKER_CONCURRENCY (the job queue's poll
// concurrency, worker/index.ts) never sped it up, however high it was set.
// This pool moves PNG encoding — the actual CPU cost — off that thread; it
// has nothing to do with the `jobs` table or worker/index.ts's polling loop
// despite living in the same directory.
//
// Encode-only since phase 4 (docs/phases/4-deploy.md section 1): the write
// used to happen right here (`writeFileSync`), but that only ever worked
// for the fs backend — this thread hands the encoded PNG back to
// materialise.ts's EncodePool instead, which writes it through Storage
// (fs or s3) on the main thread. See EncodePool's own header comment for
// why the write didn't just move to an S3 call in this file.
import { ImageData, createCanvas } from '@napi-rs/canvas';

type InMsg = {
  width: number;
  height: number;
  rgba: ArrayBuffer;
};

declare const self: Worker;

self.onmessage = (ev: MessageEvent<InMsg>) => {
  const { width, height, rgba } = ev.data;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.putImageData(
    new ImageData(new Uint8ClampedArray(rgba), width, height),
    0,
    0,
  );
  const png = canvas.encodeSync('png');
  const out = png.buffer.slice(
    png.byteOffset,
    png.byteOffset + png.byteLength,
  ) as ArrayBuffer;
  postMessage({ png: out }, [out]);
};
