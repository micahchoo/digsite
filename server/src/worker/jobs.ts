// The three job kinds (docs/phases/1-map.md "Upload as a worker" and
// "Materialised coarse levels"): `ladder` (decode, cap at 4096, paint,
// mark ready), `rank-rebuild` (debounced per board, rebuilds every sort
// this board has ever had ranked), `materialise` (writes z <= -3 tiles to
// disk for one sort). The enqueue* functions here are the only way
// anything inserts into `jobs` — worker/index.ts only claims and retries
// them; it does not know what a job means.
import { parseSortId, sortId as toSortId } from '@digsite/shared/board/sort';
import {
  type Canvas,
  type Image,
  createCanvas,
  loadImage,
} from '@napi-rs/canvas';
import { paintLadder } from '../boards/ladder.ts';
import { materialiseSort } from '../boards/materialise.ts';
import { originalKey } from '../boards/paths.ts';
import { ensureRank, markBoardRanksStale } from '../boards/ranks.ts';
import { pool } from '../db/pool.ts';
import { env } from '../env.ts';
import { storageFromEnv } from '../storage/index.ts';

const MAX_SIDE = 4096; // Figma's cap — same bound the request used to apply inline

// docs/measurements/phase-5.md "After the leftovers", problem 1, lead
// review round 2's site audit: an oversized upload's resize used to
// `createCanvas` per job. Rarer than the tile/ladder leaks (only images
// past MAX_SIDE hit this branch, and WORKER_CONCURRENCY — 4 by default —
// already bounds how many run at once, unlike the unbounded HTTP paths
// fixed elsewhere), but the same defect on a long-running worker process:
// every resize permanently leaks its canvas. Variable dimensions per
// image, same reuse-by-resize trick as boards/routes.ts's
// `originalPreview` — an uncapped free list, correctness following from
// WORKER_CONCURRENCY already bounding concurrent jobs rather than from a
// separate semaphore here.
const resizePool: Canvas[] = [];

function acquireResizeCanvas(w: number, h: number): Canvas {
  const canvas = resizePool.pop();
  if (canvas) {
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    return canvas;
  }
  return createCanvas(w, h);
}

// Phase 5 section 4 (docs/phases/5-hardening.md "Operability", the worker
// bullet): a decode failure is deterministic — the same bytes fail the
// same way every time (this file's pre-phase-5 comment on `fail()`,
// worker/index.ts) — so it gets no backoff, same as before. A DecodeError
// is worker/index.ts's ONLY hook into what a job's failure means; every
// other throw (storage unreachable, a transient error) gets the backoff.
export class DecodeError extends Error {}

/** `loadImage` with a hard timeout (env.DECODE_TIMEOUT_MS — section 2's
 * "decode inside the worker with a timeout"), so a pathological file (a
 * decompression-bomb-shaped one the header-level pixel budget in
 * boards/validate.ts didn't catch, or one already past that check because
 * it predates it) can't tie up a worker slot indefinitely. A timeout is
 * itself a DecodeError: it's these bytes, decoded by this decoder, that
 * are the problem — retrying with the same bytes would just time out
 * again three more times before backoff even had a chance to matter. */
async function decodeWithTimeout(bytes: Buffer): Promise<Image> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new DecodeError(`decode timed out after ${env.DECODE_TIMEOUT_MS}ms`),
        ),
      env.DECODE_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([loadImage(bytes), timeout]);
  } catch (err) {
    if (err instanceof DecodeError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new DecodeError(message);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function enqueueJob(
  kind: string,
  payload: Record<string, unknown>,
  runAfter: Date = new Date(),
): Promise<void> {
  await pool.query(
    'INSERT INTO jobs (kind, payload, run_after) VALUES ($1,$2,$3)',
    [kind, JSON.stringify(payload), runAfter],
  );
}

export async function enqueueLadderJob(
  boardId: string,
  imageId: string,
): Promise<void> {
  await enqueueJob('ladder', { boardId, imageId });
}

export async function enqueueMaterialiseJob(
  boardId: string,
  sid: string,
): Promise<void> {
  await enqueueJob('materialise', { boardId, sortId: sid });
}

/** One pending rank-rebuild per board — a second call while one is already
 * pending pushes its run_after out another 2s instead of adding a row
 * (jobs_rank_rebuild_pending_board, 0003_phase1.sql). */
export async function enqueueRankRebuildDebounced(
  boardId: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO jobs (kind, payload, run_after)
     VALUES ('rank-rebuild', jsonb_build_object('boardId', $1::text), now() + interval '2 seconds')
     ON CONFLICT ((payload->>'boardId'))
       WHERE kind = 'rank-rebuild' AND state = 'pending'
       DO UPDATE SET run_after = now() + interval '2 seconds'`,
    [boardId],
  );
}

async function runLadderJob(payload: Record<string, unknown>): Promise<void> {
  const boardId = payload.boardId as string;
  const imageId = payload.imageId as string;

  const { rows } = await pool.query(
    'SELECT slot, sha256 FROM images WHERE id = $1',
    [imageId],
  );
  const image = rows[0];
  if (!image) return; // the image was deleted before the job ran

  const key = originalKey(boardId, image.sha256);
  const storage = storageFromEnv();
  const bytes = await storage.get(key);
  // Not a DecodeError: the bytes were never even reached, so retrying
  // later (with backoff — worker/index.ts) is exactly right for a
  // just-cleaned-up-by-something-else or momentarily-unreachable object,
  // and pointless for a genuinely corrupt file (that's the branch below).
  if (!bytes) throw new Error(`original missing: ${key}`);
  // decodeWithTimeout throws DecodeError on a corrupt/non-image upload or
  // a decode that runs past DECODE_TIMEOUT_MS — no backoff either way
  // (worker/index.ts), since retrying decodes the same bytes again.
  const decoded = await decodeWithTimeout(Buffer.from(bytes));

  let width = decoded.width;
  let height = decoded.height;
  let paintSource = decoded;

  if (width > MAX_SIDE || height > MAX_SIDE) {
    const scale = MAX_SIDE / Math.max(width, height);
    const nw = Math.round(width * scale);
    const nh = Math.round(height * scale);
    const canvas = acquireResizeCanvas(nw, nh);
    let resized: Buffer;
    try {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, nw, nh);
      ctx.drawImage(decoded, 0, 0, nw, nh);
      resized = canvas.encodeSync('png');
    } finally {
      resizePool.push(canvas);
    }
    await storage.put(key, resized, 'image/png'); // same content-addressed key, now capped — matches the old inline behaviour
    width = nw;
    height = nh;
    paintSource = await decodeWithTimeout(resized);
  }

  await paintLadder(boardId, image.slot, paintSource, width, height);
  await pool.query(
    'UPDATE images SET width = $1, height = $2, status = $3 WHERE id = $4',
    [width, height, 'ready', imageId],
  );
  await markBoardRanksStale(boardId);
  await enqueueRankRebuildDebounced(boardId);
}

async function runRankRebuildJob(
  payload: Record<string, unknown>,
): Promise<void> {
  const boardId = payload.boardId as string;
  const { rows } = await pool.query(
    'SELECT sort_id FROM board_rank_state WHERE board_id = $1',
    [boardId],
  );
  for (const row of rows) {
    const sort = parseSortId(row.sort_id);
    if (!sort) continue;
    const { built } = await ensureRank(boardId, sort);
    if (built) await enqueueMaterialiseJob(boardId, toSortId(sort));
  }
}

async function runMaterialiseJob(
  payload: Record<string, unknown>,
): Promise<void> {
  const boardId = payload.boardId as string;
  const sort = parseSortId(payload.sortId as string);
  if (!sort) return;
  await materialiseSort(boardId, sort);
}

export async function runJob(
  kind: string,
  payload: Record<string, unknown>,
): Promise<void> {
  if (kind === 'ladder') return runLadderJob(payload);
  if (kind === 'rank-rebuild') return runRankRebuildJob(payload);
  if (kind === 'materialise') return runMaterialiseJob(payload);
  throw new Error(`unknown job kind: ${kind}`);
}

/** Runs after a job has exhausted its attempts (worker/index.ts). Only
 * `ladder` has a visible side effect — mark the image `failed` with the
 * reason on the row, per docs/phases/1-map.md "three attempts, then
 * failed with the reason on the row". */
export async function onJobFailedFinal(
  kind: string,
  payload: Record<string, unknown>,
  reason: string,
): Promise<void> {
  if (kind !== 'ladder') return;
  const imageId = payload.imageId as string | undefined;
  if (!imageId) return;
  await pool.query('UPDATE images SET status = $1, error = $2 WHERE id = $3', [
    'failed',
    reason,
    imageId,
  ]);
}
