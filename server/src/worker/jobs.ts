// The three job kinds (docs/phases/1-map.md "Upload as a worker" and
// "Materialised coarse levels"): `ladder` (decode, cap at 4096, paint,
// mark ready), `rank-rebuild` (debounced per board, rebuilds every sort
// this board has ever had ranked), `materialise` (writes z <= -3 tiles to
// disk for one sort), plus `embed`, `arrange` and `folder-import`. Every
// job is queued through worker/schedule.ts; worker/index.ts only claims
// and retries them; it does not know what a job means.
import { LADDER, type LadderSize, perPage } from '@digsite/shared/board/ladder';
import { parseSortId, sortId as toSortId } from '@digsite/shared/board/sort';
import { boardChanged, pagesRepainted } from '../boards/change.ts';
import { type LadderPaint, paintLadderMany } from '../boards/ladder.ts';
import { materialiseSort } from '../boards/materialise.ts';
import { originalKey } from '../boards/paths.ts';
import { ensureRank } from '../boards/ranks.ts';
import { pool } from '../db/pool.ts';
import { env } from '../env.ts';
import { MODEL, toVectorText } from '../meaning/model.ts';
import { storageFromEnv } from '../storage/index.ts';
import { capturedProperties } from './captured.ts';
import { decodeOriginal } from './decode.ts';
import { type JobKind, isJobKind, schedule } from './schedule.ts';

// worker/index.ts's one hook into what a failure means: a DecodeError is
// retried without backoff, anything else with it.
export { DecodeError } from './decode.ts';

type Prepared = {
  id: string;
  width: number;
  height: number;
  paint: LadderPaint;
  captured: Record<string, unknown>;
};

/** Everything one image needs before it can be painted. Throws that image's
 * own failure: a missing original (retried with backoff) or a DecodeError
 * (retried without). Null when the image was deleted before its job ran. */
async function prepare(
  boardId: string,
  row: { id: string; slot: number; sha256: string } | undefined,
): Promise<Prepared | null> {
  if (!row) return null;
  const key = originalKey(boardId, row.sha256);
  const storage = storageFromEnv();
  const bytes = await storage.get(key);
  // Not a DecodeError: the bytes were never reached, so a retry with
  // backoff is right for a momentarily unreachable object.
  if (!bytes) throw new Error(`original missing: ${key}`);
  const original = Buffer.from(bytes);
  const [decoded, captured] = await Promise.all([
    decodeOriginal(original),
    capturedProperties(original),
  ]);
  if (decoded.capped) {
    // Same content-addressed key, now capped — matches the old inline behaviour.
    await storage.put(key, decoded.capped, 'image/png');
  }
  return {
    id: row.id,
    captured,
    width: decoded.width,
    height: decoded.height,
    paint: { slot: row.slot, cells: decoded.cells },
  };
}

/** Ladder jobs for images of ONE board. Each image is prepared on its own,
 * so one bad file fails only its job; the survivors are painted together,
 * one load and one encode per page (paintLadderMany). Returns each job's
 * outcome in order: null for done, else its error. A failure painting the
 * group is every survivor's failure. */
export async function runLadderGroup(
  boardId: string,
  imageIds: string[],
): Promise<(unknown | null)[]> {
  const { rows } = await pool.query(
    'SELECT id, slot, sha256 FROM images WHERE id = ANY($1::uuid[])',
    [imageIds],
  );
  const byId = new Map(rows.map((row) => [row.id as string, row]));
  const outcomes = await Promise.allSettled(
    imageIds.map((id) => prepare(boardId, byId.get(id))),
  );
  const results: (unknown | null)[] = outcomes.map((o) =>
    o.status === 'rejected' ? o.reason : null,
  );
  const ready = outcomes.flatMap((o) =>
    o.status === 'fulfilled' && o.value ? [o.value] : [],
  );
  if (ready.length === 0) return results;

  try {
    const painted = await paintLadderMany(
      boardId,
      ready.map((p) => p.paint),
    );
    // This process holds the new pages; any other holds old pixels.
    await pagesRepainted(boardId, painted);
    // Captured properties go UNDER the image's own: in `a || b` the right
    // side wins, so anything already set is kept.
    await pool.query(
      `UPDATE images i SET width = u.width, height = u.height, status = 'ready',
         properties = u.captured::jsonb || i.properties
       FROM unnest($1::uuid[], $2::int[], $3::int[], $4::text[])
         AS u(id, width, height, captured)
       WHERE i.id = u.id`,
      [
        ready.map((p) => p.id),
        ready.map((p) => p.width),
        ready.map((p) => p.height),
        ready.map((p) => JSON.stringify(p.captured)),
      ],
    );
    await boardChanged(boardId);
    await schedule('rank-rebuild', { boardId });
    if (env.EMBEDDINGS) {
      await schedule('embed', { boardId, imageIds: ready.map((p) => p.id) });
    }
  } catch (error) {
    const failed = new Set(ready.map((p) => p.id));
    imageIds.forEach((id, i) => {
      if (failed.has(id)) results[i] = error;
    });
  }
  return results;
}

/** CLIP embeddings for images already painted (meaning/clip.ts). An image
 * deleted, or whose original is gone, is skipped: an embedding is derived
 * data, and its absence only leaves that image out of similarity. A model
 * that fails to load fails the job, which retries with backoff. */
async function runEmbedJob(payload: Record<string, unknown>): Promise<void> {
  const boardId = payload.boardId as string;
  const imageIds = payload.imageIds as string[];
  const { rows } = await pool.query(
    'SELECT id, slot, sha256 FROM images WHERE id = ANY($1::uuid[])',
    [imageIds],
  );
  const storage = storageFromEnv();
  const found: { id: string; slot: number; bytes: Uint8Array }[] = [];
  for (const row of rows) {
    const bytes = await storage.get(originalKey(boardId, row.sha256));
    if (bytes) found.push({ id: row.id, slot: row.slot, bytes });
  }
  if (found.length === 0) return;
  // Loaded here, not at the top: only a worker with embeddings on pays for
  // ONNX Runtime (meaning/model.ts). One model call for the whole group.
  const { embedImages } = await import('../meaning/clip.ts');
  const vectors = await embedImages(found.map((f) => f.bytes));
  await pool.query(
    `INSERT INTO image_embeddings (image_id, model, board_id, slot, embedding)
     SELECT u.id, $1, $2, u.slot, u.v::halfvec
     FROM unnest($3::uuid[], $4::int[], $5::text[]) AS u(id, slot, v)
     ON CONFLICT (image_id, model) DO UPDATE SET embedding = EXCLUDED.embedding`,
    [
      MODEL,
      boardId,
      found.map((f) => f.id),
      found.map((f) => f.slot),
      vectors.map(toVectorText),
    ],
  );
  await schedule('arrange', { boardId });
}

async function runLadderJob(payload: Record<string, unknown>): Promise<void> {
  const [error] = await runLadderGroup(payload.boardId as string, [
    payload.imageId as string,
  ]);
  if (error) throw error;
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
    if (built) {
      await schedule('materialise', { boardId, sortId: toSortId(sort) });
    }
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

export type ClaimedJob = {
  id: number;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
};

/** Jobs run together, and each one's outcome: null for done, else its
 * error. worker/index.ts runs units and records outcomes; it never needs to
 * know why jobs share a unit. */
export type Unit = {
  jobs: ClaimedJob[];
  run: () => Promise<(unknown | null)[]>;
};

/** The most ladder jobs worth painting together: one S=128 page, which is
 * also inside one page of every smaller size. */
export const GROUP = perPage(Math.max(...LADDER) as LadderSize);

/** Ladder jobs whose images share a board and an S=128 page become one
 * unit; every other job is a unit of its own. */
export async function planUnits(jobs: ClaimedJob[]): Promise<Unit[]> {
  const ladder = jobs.filter((job) => job.kind === 'ladder');
  const { rows } = await pool.query(
    'SELECT id, slot FROM images WHERE id = ANY($1::uuid[])',
    [ladder.map((job) => job.payload.imageId as string)],
  );
  const slotOf = new Map(rows.map((row) => [row.id as string, row.slot]));
  const groups = new Map<string, ClaimedJob[]>();
  for (const job of ladder) {
    const slot = slotOf.get(job.payload.imageId as string);
    // A deleted image has no slot; alone, its job simply finds nothing.
    const key =
      slot === undefined
        ? `job:${job.id}`
        : `${job.payload.boardId}:${Math.floor(slot / GROUP)}`;
    groups.set(key, [...(groups.get(key) ?? []), job]);
  }
  const units: Unit[] = [...groups.values()].map((group) => ({
    jobs: group,
    run: () =>
      runLadderGroup(
        group[0]?.payload.boardId as string,
        group.map((job) => job.payload.imageId as string),
      ),
  }));
  for (const job of jobs) {
    if (job.kind === 'ladder') continue;
    units.push({
      jobs: [job],
      run: async () => {
        try {
          await runJob(job.kind, job.payload);
          return [null];
        } catch (error) {
          return [error];
        }
      },
    });
  }
  return units;
}

type Payload = Record<string, unknown>;

/** What each kind does. A Record over JobKind: a kind added to
 * schedule.ts without a runner here does not compile. */
const RUNNERS: Record<JobKind, (payload: Payload) => Promise<void>> = {
  ladder: runLadderJob,
  'rank-rebuild': runRankRebuildJob,
  materialise: runMaterialiseJob,
  embed: runEmbedJob,
  arrange: async (payload) => {
    const { arrangeBoard } = await import('../meaning/arrangement.ts');
    await arrangeBoard(payload.boardId as string);
  },
  // Dynamic: boards/folder-import.ts reaches this file through intake.
  'folder-import': async (payload) => {
    const { runFolderImportBatch } = await import('../boards/folder-import.ts');
    await runFolderImportBatch(payload.importId as string);
  },
};

export function runJob(kind: string, payload: Payload): Promise<void> {
  if (!isJobKind(kind)) throw new Error(`unknown job kind: ${kind}`);
  return RUNNERS[kind](payload);
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
  const { rows } = await pool.query(
    'UPDATE images SET status = $1, error = $2 WHERE id = $3 RETURNING board_id',
    ['failed', reason, imageId],
  );
  // A pending cell was drawn as a placeholder and a failed one is not: the
  // pixels changed, so the order's version must (roadmap item 7).
  if (rows[0]) await boardChanged(rows[0].board_id);
}
