// Turns an uploaded original into what the ladder job needs: its oriented
// size, a picture no larger than the biggest ladder cell, and — only for an
// original past MAX_SIDE — a capped copy to store in its place.
//
// libvips (sharp) does the decode. A JPEG shrinks while it decodes, which
// took a 2048² ladder decode from 14.1 to 4.6 ms (scratch benchmark,
// 2026-09-22; PNG was 19 ms either way), and none of it goes through
// @napi-rs/canvas, whose native memory this worker has had to fence four
// times (.claude/rules/canvas-holds-its-sources.md). EXIF orientation is
// applied, as `loadImage` also did.
import sharp from 'sharp';
import { type LadderCells, ladderCells } from '../boards/ladder.ts';
import { env } from '../env.ts';
import { Semaphore } from '../util/semaphore.ts';

export const MAX_SIDE = 4096; // Figma's cap — same bound the request used to apply inline

// libvips' operation cache holds decoded images between calls; a worker
// decodes each original once, so the cache is memory with no reuse.
sharp.cache(false);

// Full-size decodes in flight, per process. A page group prepares 16
// images and the worker runs WORKER_CONCURRENCY groups, so without this a
// worker decoded up to 64 originals at once — it reached 3.4 GB in 31 s and
// was OOM-killed under a 4 GB cap (the soak, 2026-09-23). This keeps the
// pre-grouping bound: one decode per worker slot.
const decoding = new Semaphore(Math.max(1, env.WORKER_CONCURRENCY));

/** Deterministic: the same bytes fail the same way every time, so
 * worker/index.ts retries it without backoff. */
export class DecodeError extends Error {}

export type Decoded = {
  width: number;
  height: number;
  /** The picture at every ladder size, for `paintLadderMany`. */
  cells: LadderCells;
  /** PNG, longest side MAX_SIDE; set only when the original was larger. */
  capped: Buffer | null;
};

function input(bytes: Buffer) {
  return sharp(bytes, { limitInputPixels: env.UPLOAD_MAX_PIXELS }).rotate();
}

async function decode(bytes: Buffer): Promise<Decoded> {
  const meta = await sharp(bytes, {
    limitInputPixels: env.UPLOAD_MAX_PIXELS,
  }).metadata();
  if (!meta.width || !meta.height) throw new DecodeError('no image size');
  const turned = (meta.orientation ?? 1) >= 5;
  let width = turned ? meta.height : meta.width;
  let height = turned ? meta.width : meta.height;

  let capped: Buffer | null = null;
  if (width > MAX_SIDE || height > MAX_SIDE) {
    const out = await input(bytes)
      .resize(MAX_SIDE, MAX_SIDE, { fit: 'inside' })
      .png()
      .toBuffer({ resolveWithObject: true });
    capped = out.data;
    width = out.info.width;
    height = out.info.height;
  }
  const cells = await ladderCells(bytes, env.UPLOAD_MAX_PIXELS);
  return { width, height, cells, capped };
}

/** `decode` with a hard timeout (env.DECODE_TIMEOUT_MS), so a pathological
 * file cannot hold a worker slot. Any failure, the timeout included, is a
 * DecodeError: retrying these bytes with this decoder fails again. */
export function decodeOriginal(bytes: Buffer): Promise<Decoded> {
  // The clock starts when the decode does, not while it waits for a slot:
  // a file queued behind others is not a slow file.
  return decoding.run(async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new DecodeError(
              `decode timed out after ${env.DECODE_TIMEOUT_MS}ms`,
            ),
          ),
        env.DECODE_TIMEOUT_MS,
      );
    });
    try {
      return await Promise.race([decode(bytes), timeout]);
    } catch (err) {
      if (err instanceof DecodeError) throw err;
      throw new DecodeError(err instanceof Error ? err.message : String(err));
    } finally {
      if (timer) clearTimeout(timer);
    }
  });
}
