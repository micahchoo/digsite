import { type Zoom, tileRanks } from '@digsite/shared/board/grid';
// Rank tables (CONTEXT.md "Rank"): an image's position under one sort,
// 0..N-1, materialised per (board, sort_id) and rebuilt whole, never
// patched — see .claude/rules/ladder-slot-vs-rank.md. `slotsForTile` looks
// ranks up with `unnest($1::int[]) JOIN board_ranks`, 5-7x faster than
// `= ANY($1)` at the coarsest tile's 4,096 ranks (measured in
// ../../prototype/board/RESULTS.md).
import { type Sort, sortId } from '@digsite/shared/board/sort';
import { pool } from '../db/pool.ts';
import { invalidateResidentSort } from './coarse-cache.ts';
import { invalidateComposedTiles } from './tiles-cache.ts';

// board_ranks.board_id has no FK to boards(id) as of 0004_ranks_no_fk.sql —
// the per-row FK-check trigger cost ~4s of a 6.7s rebuild on the
// 1,000,000-image board (docs/measurements/phase-1-map.md "Row 1"). The
// only writer is rebuildRank below, and its board_id always comes from a
// SELECT against `images`/`boards`, never from a caller — enforcement is
// this module, not the schema. Phase 3's board delete must delete this
// board's board_ranks rows explicitly, in the same transaction as the
// boards row; there is no FK left to do it for you.
//
// board_ranks is partitioned by board_id (HASH, 16 partitions) as of
// 0007_board_ranks_partitioned.sql (docs/phases/5-hardening.md section 5,
// measured against list-per-board on the 1,000,000-image board in
// docs/measurements/phase-5.md — hash kept; see that migration's own
// comment for why). Every query below is unchanged: Postgres routes a
// board_id-scoped INSERT/DELETE/SELECT to (or from) the right partition on
// its own, so this file's SQL is byte-for-byte what it was before the
// migration — the partitioning is entirely a schema/planner concern.

function orderExpr(sort: Sort): string {
  const dir = sort.dir === 'asc' ? 'ASC' : 'DESC';
  if (sort.key === 'name') return `name ${dir} NULLS LAST, slot ASC`;
  if (sort.key === 'uploaded_at')
    return `uploaded_at ${dir} NULLS LAST, slot ASC`;
  // sort.key.property passed parseSortId's PROPERTY_RE (alnum/_/-) already,
  // by the only two callers that build a Sort from a URL — see boards/tiles.ts
  // and boards/routes.ts. Never build a Sort here from unvalidated input.
  const { property, type } = sort.key;
  const cast =
    type === 'number' ? '::numeric' : type === 'boolean' ? '::boolean' : '';
  return `(properties->>'${property}')${cast} ${dir} NULLS LAST, slot ASC`;
}

// docs/measurements/phase-5.md "After the leftovers", problem 3: a sort
// nobody has asked for in a long time is dead weight in board_ranks_pkey
// that every OTHER sort on the same board's partition pays to maintain —
// see 0009_rank_sweep.sql's header for the full root-cause chain. Bumping
// last_requested_at on literally every ensureRank call (i.e. every tile
// request) would add a write to the hottest read path in the app for no
// real precision a sweep measured in days needs — throttled to once per
// this interval instead.
const TOUCH_THROTTLE_MS = 60 * 60 * 1000; // 1 hour

async function touchLastRequested(boardId: string, sid: string): Promise<void> {
  await pool.query(
    `UPDATE board_rank_state SET last_requested_at = now()
     WHERE board_id = $1 AND sort_id = $2`,
    [boardId, sid],
  );
}

/** Deletes board_ranks + board_rank_state for every (board, sort) pair
 * nobody has requested in `olderThanDays` — the fix for problem 3's actual
 * root cause (a board's own accumulated multi-sort history, not board-to-
 * board sharing, which partitioning by board_id alone cannot touch). Global
 * across every board, matching the brief's own framing ("sorts nobody has
 * requested"). Safe to run at any time: `ensureRank` already rebuilds a
 * missing (board, sort) row transparently on the next request — the same
 * path it takes for a `stale` one today — so a sweep never produces a wrong
 * answer, only, occasionally, one slow rebuild for a sort that turns out to
 * still be wanted. Call from an operator's cron, not wired to a timer here
 * (worker/index.ts's poll loop is per-job, not a place to hang a
 * once-a-day sweep) — server/scripts/sweep-ranks.ts is the entry point. */
export async function sweepStaleRanks(
  olderThanDays: number,
): Promise<{ sorts: number; rows: number }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const stale = await client.query(
      `SELECT board_id, sort_id FROM board_rank_state
       WHERE last_requested_at < now() - ($1 || ' days')::interval`,
      [String(olderThanDays)],
    );
    let rows = 0;
    for (const s of stale.rows) {
      const del = await client.query(
        'DELETE FROM board_ranks WHERE board_id = $1 AND sort_id = $2',
        [s.board_id, s.sort_id],
      );
      rows += del.rowCount ?? 0;
    }
    await client.query(
      `DELETE FROM board_rank_state
       WHERE last_requested_at < now() - ($1 || ' days')::interval`,
      [String(olderThanDays)],
    );
    await client.query('COMMIT');
    for (const s of stale.rows) {
      invalidateComposedTiles(s.board_id as string);
      invalidateResidentSort(s.board_id as string);
    }
    return { sorts: stale.rows.length, rows };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function markBoardRanksStale(boardId: string): Promise<void> {
  await pool.query(
    'UPDATE board_rank_state SET stale = true WHERE board_id = $1',
    [boardId],
  );
  invalidateComposedTiles(boardId);
  invalidateResidentSort(boardId);
}

/** Unconditionally rebuilds (board, sort)'s rank table — `ensureRank` checks
 * `stale` first; this is for a caller that wants a rebuild regardless (the
 * manual `POST /boards/:id/sort/:sortId/rebuild` route). */
export async function forceRebuildRank(
  boardId: string,
  sort: Sort,
): Promise<void> {
  return rebuildRank(boardId, sort);
}

/** Reported by the coordinator against the owner's demo server (same code,
 * shared database): two rank rebuilds of the same (board, sort) running
 * concurrently — two `ensureRank` callers both reading `stale`/missing
 * before either commits, or an `ensureRank` racing a manual
 * `forceRebuildRank` — both compute and INSERT the IDENTICAL target row
 * set (same images, same sort => same ranks), and under READ COMMITTED
 * the second transaction's INSERT collides with the first's just-committed
 * rows: `duplicate key value violates unique constraint
 * "board_ranks_p10_pkey"`. `rebuildRank` now serialises per (board, sort)
 * with a transaction-scoped Postgres advisory lock (released automatically
 * on commit/rollback, so a crashed process can't leave one held) — the
 * second caller blocks here until the first commits, then re-checks
 * `built_at` against a timestamp captured BEFORE this call even started
 * waiting: if the winner's commit landed after that (a genuine race), this
 * caller's own request is already satisfied and it does no work, instead
 * of redoing the identical INSERT the lock exists to prevent colliding on.
 * A NON-racing `forceRebuildRank` call (the ordinary case — an admin
 * clicking "rebuild" once) always sees `built_at <= requestedAt` here
 * (there was no time for anyone else's commit to land after this call's
 * own start), so its "rebuild regardless of staleness" contract is
 * unaffected. See ranks.test.ts's concurrent-rebuild test. */
async function rebuildRank(boardId: string, sort: Sort): Promise<void> {
  const sid = sortId(sort);
  const requestedAt = new Date();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `${boardId}:${sid}`,
    ]);
    const { rows: raced } = await client.query(
      'SELECT built_at FROM board_rank_state WHERE board_id = $1 AND sort_id = $2',
      [boardId, sid],
    );
    const builtAt = raced[0]?.built_at as Date | undefined;
    if (builtAt && builtAt > requestedAt) {
      await client.query('COMMIT');
      return;
    }
    await client.query(
      'DELETE FROM board_ranks WHERE board_id = $1 AND sort_id = $2',
      [boardId, sid],
    );
    await client.query(
      `INSERT INTO board_ranks (board_id, sort_id, rank, slot)
       SELECT $1, $2, (ROW_NUMBER() OVER (ORDER BY ${orderExpr(sort)}) - 1)::int, slot
       FROM images WHERE board_id = $1`,
      [boardId, sid],
    );
    await client.query(
      `INSERT INTO board_rank_state (board_id, sort_id, built_at, stale, last_requested_at)
       VALUES ($1, $2, now(), false, now())
       ON CONFLICT (board_id, sort_id) DO UPDATE SET built_at = now(), stale = false, last_requested_at = now()`,
      [boardId, sid],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  invalidateComposedTiles(boardId);
  invalidateResidentSort(boardId);
}

/** Rebuilds (board, sort)'s rank table if it has never been built or was
 * marked stale by an upload. Cheap when already fresh: one indexed read. */
export async function ensureRank(
  boardId: string,
  sort: Sort,
): Promise<{ built: boolean; ms: number }> {
  const sid = sortId(sort);
  const { rows } = await pool.query(
    'SELECT stale, last_requested_at FROM board_rank_state WHERE board_id = $1 AND sort_id = $2',
    [boardId, sid],
  );
  if (rows.length > 0 && !rows[0].stale) {
    // One extra UPDATE round-trip per tile request (this is on the hottest
    // read path in the app) only when actually due — the throttle window
    // read back here, decided client-side, instead of a WHERE clause that
    // would still cost a full round-trip every time even on the (typical)
    // no-op case.
    const lastRequested = rows[0].last_requested_at as Date;
    if (Date.now() - lastRequested.getTime() > TOUCH_THROTTLE_MS) {
      await touchLastRequested(boardId, sid);
    }
    return { built: false, ms: 0 };
  }
  const start = performance.now();
  await rebuildRank(boardId, sort);
  return { built: true, ms: performance.now() - start };
}

export async function slotsForTile(
  boardId: string,
  sort: Sort,
  z: Zoom,
  x: number,
  y: number,
): Promise<(number | null)[]> {
  await ensureRank(boardId, sort);

  const ranks = tileRanks(z, x, y);
  const out: (number | null)[] = new Array(ranks.length).fill(null);
  const wanted: { rank: number; idx: number }[] = [];
  ranks.forEach((r, idx) => {
    if (r >= 0) wanted.push({ rank: r, idx });
  });
  if (wanted.length === 0) return out;

  const sid = sortId(sort);
  const { rows } = await pool.query(
    `SELECT r.rank, br.slot FROM unnest($1::int[]) AS r(rank)
     JOIN board_ranks br ON br.rank = r.rank AND br.board_id = $2 AND br.sort_id = $3`,
    [wanted.map((w) => w.rank), boardId, sid],
  );
  const found = new Map<number, number>();
  for (const row of rows) found.set(row.rank, row.slot);
  for (const w of wanted) out[w.idx] = found.get(w.rank) ?? null;
  return out;
}

/** Images in rank order, for `GET /boards/:id/images` — the click-to-image
 * lookup and the sheet-member picker both page through this. */
export async function imagesInRankOrder(
  boardId: string,
  sort: Sort,
  from: number,
  count: number,
): Promise<{ rank: number; imageId: string }[]> {
  await ensureRank(boardId, sort);
  const sid = sortId(sort);
  const { rows } = await pool.query(
    `SELECT br.rank, i.id AS image_id FROM board_ranks br
     JOIN images i ON i.board_id = br.board_id AND i.slot = br.slot
     WHERE br.board_id = $1 AND br.sort_id = $2 AND br.rank >= $3
     ORDER BY br.rank ASC LIMIT $4`,
    [boardId, sid, from, count],
  );
  return rows.map((r) => ({ rank: r.rank, imageId: r.image_id }));
}
