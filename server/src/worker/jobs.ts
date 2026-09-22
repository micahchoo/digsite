// The three job kinds (docs/phases/1-map.md "Upload as a worker" and
// "Materialised coarse levels"): `ladder` (decode, cap at 4096, paint,
// mark ready), `rank-rebuild` (debounced per board, rebuilds every sort
// this board has ever had ranked), `materialise` (writes z <= -3 tiles to
// disk for one sort). The enqueue* functions here are the only way
// anything inserts into `jobs` — worker/index.ts only claims and retries
// them; it does not know what a job means.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseSortId, sortId as toSortId } from '@digsite/shared/board/sort';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { paintLadder } from '../boards/ladder.ts';
import { materialiseSort } from '../boards/materialise.ts';
import { originalPath } from '../boards/paths.ts';
import { ensureRank, markBoardRanksStale } from '../boards/ranks.ts';
import { pool } from '../db/pool.ts';

const MAX_SIDE = 4096; // Figma's cap — same bound the request used to apply inline

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

  const path = originalPath(boardId, image.sha256);
  const bytes = readFileSync(path); // throws (retried, then failed) if the original is gone or unreadable
  const decoded = await loadImage(bytes); // throws on a corrupt/non-image upload

  let width = decoded.width;
  let height = decoded.height;
  let paintSource = decoded;

  if (width > MAX_SIDE || height > MAX_SIDE) {
    const scale = MAX_SIDE / Math.max(width, height);
    const nw = Math.round(width * scale);
    const nh = Math.round(height * scale);
    const canvas = createCanvas(nw, nh);
    canvas.getContext('2d').drawImage(decoded, 0, 0, nw, nh);
    const resized = canvas.encodeSync('png');
    writeFileSync(path, resized); // same content-addressed path, now capped — matches the old inline behaviour
    width = nw;
    height = nh;
    paintSource = await loadImage(resized);
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
