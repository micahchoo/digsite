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
//
// docs/measurements/phase-5.md "After the leftovers", problem 1, lead
// review round 2's site audit: the `createCanvas` per message below is NOT
// pooled, on purpose. `EncodePool` spawns a fresh batch of these workers
// per `materialiseSort` call and always `terminate()`s them in a `finally`
// right after — a Bun `Worker.terminate()` tears down the whole OS
// thread/V8 isolate, which reclaims every canvas this thread ever created
// regardless of whether @napi-rs/canvas's own finalizer ever runs. Already
// measured in isolation (phase-1-map.md's own "Fix 2": 5,216 tiles through
// 30 of these threads, RSS flat at ~400 MB) — a materialise pass's peak
// here is real but bounded and fully reclaimed at `terminate()`, never
// compounding across passes the way materialise.ts's own main-thread
// destination-tile canvases did before this same round pooled those too.
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
