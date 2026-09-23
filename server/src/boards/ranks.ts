import { createHash } from 'node:crypto';
import { COLS, type Zoom, tileRanks } from '@digsite/shared/board/grid';
// Ranks (CONTEXT.md "Rank"): an image's position under one sort, 0..N-1,
// rebuilt whole, never patched — see .claude/rules/ladder-slot-vs-rank.md.
//
// A sort's ranks are ONE value: board_rank_state.slot_order, every slot of
// the board in rank order as 4-byte big-endian integers, built by one
// string_agg(... ORDER BY ...) in Postgres (0017_rank_order.sql). Readers
// hold it decoded, as `RankOrder`, keyed by its build (`version`), so a
// rebuild in another process is noticed on the next read of the state row
// every reader already makes — nothing to invalidate.
//
// Measured 2026-09-23 on a 1,000,000-image board: the board_ranks table
// this replaces rebuilt in 1.5-6.0 s per sort; slot_order in 0.3-1.1 s,
// loading in 28 ms and decoding in 13 ms.
import { type Sort, sortId } from '@digsite/shared/board/sort';
import { pool } from '../db/pool.ts';
import { env } from '../env.ts';
import { catchUp, invalidate } from './invalidation.ts';
import { ensurePropertyIndex } from './property-index.ts';

/** The ORDER BY that defines a sort. The rebuild and sections.ts must use
 * exactly this, or sections would disagree with the map. Bare column
 * names, so it reads the same with or without an `images i` alias. */
export function orderExpr(sort: Sort): string {
  const dir = sort.dir === 'asc' ? 'ASC' : 'DESC';
  if (sort.key === 'name') return `name ${dir} NULLS LAST, slot ASC`;
  if (sort.key === 'uploaded_at')
    return `uploaded_at ${dir} NULLS LAST, slot ASC`;
  // sort.key.property passed parseSortId's PROPERTY_RE (alnum/_/-) already,
  // by the only two callers that build a Sort from a URL — see boards/tiles.ts
  // and boards/routes.ts. Never build a Sort here from unvalidated input.
  const { property, type } = sort.key;
  // ISO dates sort chronologically as fixed-width YYYY-MM-DD strings.
  // Lists sort by their first scalar member; empty lists are NULLS LAST.
  if (type === 'list') {
    return `(CASE WHEN jsonb_typeof(properties->'${property}') = 'array' THEN properties->'${property}'->>0 END) ${dir} NULLS LAST, slot ASC`;
  }
  if (type === 'number') {
    return `(CASE WHEN jsonb_typeof(properties->'${property}') = 'number' THEN (properties->>'${property}')::numeric END) ${dir} NULLS LAST, slot ASC`;
  }
  if (type === 'boolean') {
    return `(CASE WHEN jsonb_typeof(properties->'${property}') = 'boolean' THEN (properties->>'${property}')::boolean END) ${dir} NULLS LAST, slot ASC`;
  }
  return `(CASE WHEN jsonb_typeof(properties->'${property}') = 'string' THEN properties->>'${property}' END) ${dir} NULLS LAST, slot ASC`;
}

/** One build of one sort, decoded. */
export type RankOrder = {
  /** The build this is (built_at to the microsecond, as text). */
  version: string;
  /** slotOfRank[rank] is the slot at that rank; length is the ranked count. */
  slotOfRank: Int32Array;
  /** rankOfSlot[slot] is its rank, or -1 for a slot this build has not seen
   * (uploaded after it). Index past the end is also "not ranked". */
  rankOfSlot: Int32Array;
};

/** The version as a client carries it: short and URL-safe. A tile URL
 * with `?v=` equal to its order's token may be cached for good. */
export function orderToken(version: string): string {
  return createHash('sha256').update(version).digest('base64url').slice(0, 16);
}

export function rankOf(order: RankOrder, slot: number): number {
  return slot < order.rankOfSlot.length ? (order.rankOfSlot[slot] ?? -1) : -1;
}

function decodeOrder(version: string, bytes: Buffer): RankOrder {
  // int4send is big-endian; swap into the platform's order in one pass.
  const copy = new Uint8Array(bytes);
  const slotOfRank = new Int32Array(copy.buffer, 0, copy.length / 4);
  const view = new DataView(copy.buffer);
  for (let i = 0; i < slotOfRank.length; i++)
    slotOfRank[i] = view.getInt32(i * 4, false);
  let maxSlot = -1;
  for (const slot of slotOfRank) if (slot > maxSlot) maxSlot = slot;
  const rankOfSlot = new Int32Array(maxSlot + 1).fill(-1);
  for (let rank = 0; rank < slotOfRank.length; rank++)
    rankOfSlot[slotOfRank[rank] as number] = rank;
  return { version, slotOfRank, rankOfSlot };
}

// Decoded orders, LRU by insertion order, bounded by RANK_CACHE_MB. Two
// Int32Arrays per order: ~8 MB per sort of a million-image board.
const orders = new Map<string, RankOrder>();
let orderBytes = 0;

/** Decoded orders held right now, for GET /metrics. */
export function rankCacheBytes(): number {
  return orderBytes;
}

function bytesOf(order: RankOrder): number {
  return order.slotOfRank.byteLength + order.rankOfSlot.byteLength;
}

function remember(key: string, order: RankOrder): void {
  const old = orders.get(key);
  if (old) {
    orders.delete(key);
    orderBytes -= bytesOf(old);
  }
  orders.set(key, order);
  orderBytes += bytesOf(order);
  const budget = env.RANK_CACHE_MB * 1024 * 1024;
  for (const [k, o] of orders) {
    if (orderBytes <= budget || k === key) break;
    orders.delete(k);
    orderBytes -= bytesOf(o);
  }
}

// docs/measurements/phase-5.md "After the leftovers", problem 3: a sweep
// deletes sorts nobody has asked for in a while (sweepStaleRanks). Bumping
// last_requested_at on every read (every tile request) would put a write on
// the hottest read path in the app for no precision a sweep measured in
// days needs — throttled to once per this interval instead.
const TOUCH_THROTTLE_MS = 60 * 60 * 1000; // 1 hour

async function touchLastRequested(boardId: string, sid: string): Promise<void> {
  await pool.query(
    `UPDATE board_rank_state SET last_requested_at = now()
     WHERE board_id = $1 AND sort_id = $2`,
    [boardId, sid],
  );
}

/** Deletes every (board, sort) order nobody has requested in
 * `olderThanDays`. Safe at any time: a swept sort rebuilds transparently on
 * its next request, the path a stale one already takes. Global across
 * boards; run from an operator's cron (server/scripts/sweep-ranks.ts). With
 * the order a single value this saves storage, not rebuild time. */
export async function sweepStaleRanks(
  olderThanDays: number,
): Promise<{ sorts: number }> {
  const { rows } = await pool.query(
    `DELETE FROM board_rank_state
     WHERE last_requested_at < now() - ($1 || ' days')::interval
     RETURNING board_id`,
    [String(olderThanDays)],
  );
  const boards = new Set(rows.map((row) => row.board_id as string));
  for (const boardId of boards) await invalidate({ kind: 'ranks', boardId });
  return { sorts: rows.length };
}

export async function markBoardRanksStale(boardId: string): Promise<void> {
  await pool.query(
    'UPDATE board_rank_state SET stale = true WHERE board_id = $1',
    [boardId],
  );
  await invalidate({ kind: 'ranks', boardId });
}

/** Unconditionally rebuilds (board, sort) — `ensureRank` checks `stale`
 * first; this is for a caller that wants a rebuild regardless (the manual
 * `POST /boards/:id/sort/:sortId/rebuild` route). */
export async function forceRebuildRank(
  boardId: string,
  sort: Sort,
): Promise<void> {
  return rebuildRank(boardId, sort);
}

/** Two rebuilds of one (board, sort) can race — two readers both finding it
 * stale, or a read racing the manual rebuild route. A transaction-scoped
 * advisory lock serialises them; the second then re-checks built_at
 * against a time taken before it waited, and does no work if the winner's
 * build landed after that. A non-racing forced rebuild always sees an
 * older built_at, so it still rebuilds. See ranks.test.ts's concurrent
 * rebuild test. */
async function rebuildRank(boardId: string, sort: Sort): Promise<void> {
  const sid = sortId(sort);
  const requestedAt = new Date();
  // docs/phases/6-product.md "Typed properties complete": an expression
  // index on this property, built once per board — best-effort, never
  // blocks a rebuild if it fails (a missing index costs planner time on
  // the NEXT sort/filter, not correctness).
  if (typeof sort.key !== 'string') {
    try {
      await ensurePropertyIndex(boardId, sort.key.property, sort.key.type);
    } catch {
      // best-effort, see above.
    }
  }
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
    // A rebuild makes any materialised coarse tiles describe old ranks, so
    // materialised_at is cleared until materialise runs again.
    await client.query(
      `INSERT INTO board_rank_state
         (board_id, sort_id, built_at, stale, last_requested_at, slot_order)
       VALUES ($1, $2, now(), false, now(), (
         SELECT COALESCE(string_agg(int4send(slot), ''::bytea ORDER BY ${orderExpr(sort)}), ''::bytea)
         FROM images WHERE board_id = $1))
       ON CONFLICT (board_id, sort_id) DO UPDATE SET
         built_at = now(), stale = false, last_requested_at = now(),
         materialised_at = NULL, slot_order = EXCLUDED.slot_order`,
      [boardId, sid],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  await invalidate({ kind: 'ranks', boardId });
}

type State = { stale: boolean; version: string; lastRequested: Date };

async function readState(boardId: string, sid: string): Promise<State | null> {
  const { rows } = await pool.query(
    `SELECT stale, built_at::text AS version, last_requested_at
     FROM board_rank_state WHERE board_id = $1 AND sort_id = $2`,
    [boardId, sid],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    stale: row.stale,
    version: row.version,
    lastRequested: row.last_requested_at,
  };
}

/** The state of (board, sort), rebuilt first if it has never been built or
 * an upload marked it stale. Cheap when fresh: one indexed read. */
async function freshState(
  boardId: string,
  sort: Sort,
): Promise<{ state: State | null; built: boolean; ms: number }> {
  const sid = sortId(sort);
  const state = await readState(boardId, sid);
  if (state && !state.stale) {
    // One extra UPDATE per read only when the throttle window has passed,
    // decided here rather than in SQL so the usual case costs no write.
    if (Date.now() - state.lastRequested.getTime() > TOUCH_THROTTLE_MS) {
      await touchLastRequested(boardId, sid);
    }
    return { state, built: false, ms: 0 };
  }
  const start = performance.now();
  await rebuildRank(boardId, sort);
  const ms = performance.now() - start;
  return { state: await readState(boardId, sid), built: true, ms };
}

/** Rebuilds (board, sort) if needed; for callers that need the order to be
 * current but do not read it (the rank-rebuild job, warming at startup). */
export async function ensureRank(
  boardId: string,
  sort: Sort,
): Promise<{ built: boolean; ms: number }> {
  const { built, ms } = await freshState(boardId, sort);
  return { built, ms };
}

/** The current order of (board, sort), rebuilt first if needed. Decoded
 * once per build per process; after that, one state-row read per call. */
export async function rankOrder(
  boardId: string,
  sort: Sort,
): Promise<RankOrder> {
  const { state } = await freshState(boardId, sort);
  const key = `${boardId}:${sortId(sort)}`;
  const cached = orders.get(key);
  if (cached && state && cached.version === state.version) return cached;
  const { rows } = await pool.query(
    `SELECT built_at::text AS version, slot_order
     FROM board_rank_state WHERE board_id = $1 AND sort_id = $2`,
    [boardId, sortId(sort)],
  );
  const row = rows[0];
  // Swept between the two reads: an empty order is an honest answer, and
  // the next request rebuilds.
  if (!row?.slot_order) return decodeOrder('', Buffer.alloc(0));
  const order = decodeOrder(row.version, row.slot_order);
  // A new build: before anything is drawn under its version, this process
  // applies every invalidation published before it (roadmap item 7).
  await catchUp();
  remember(key, order);
  return order;
}

export async function slotsForTile(
  boardId: string,
  sort: Sort,
  z: Zoom,
  x: number,
  y: number,
  /** The order to read, when the caller must know which build it was. */
  given?: RankOrder,
): Promise<(number | null)[]> {
  const order = given ?? (await rankOrder(boardId, sort));
  return tileRanks(z, x, y).map((rank) =>
    rank >= 0 && rank < order.slotOfRank.length
      ? (order.slotOfRank[rank] as number)
      : null,
  );
}

/** Image ids for slots, in the order given; a slot with no image is left
 * out. */
async function idsForSlots(
  boardId: string,
  slots: number[],
): Promise<string[]> {
  if (slots.length === 0) return [];
  const { rows } = await pool.query(
    'SELECT slot, id FROM images WHERE board_id = $1 AND slot = ANY($2::int[])',
    [boardId, slots],
  );
  const idOf = new Map(rows.map((row) => [row.slot as number, row.id]));
  return slots.flatMap((slot) => {
    const id = idOf.get(slot);
    return id ? [id as string] : [];
  });
}

/** Image ids for a contiguous rank RANGE, for `POST /boards/:id/selection/
 * range` (docs/phases/6-product.md "Selection on a million cells" — range
 * and band selects resolve server-side so a million-cell board never pages
 * ranks to the client). `fromRank`/`toRank` may arrive in either order (a
 * drag can run either direction) — normalised here. */
export async function imageIdsInRankRange(
  boardId: string,
  sort: Sort,
  fromRank: number,
  toRank: number,
  cap: number,
): Promise<string[]> {
  const order = await rankOrder(boardId, sort);
  const lo = Math.max(0, Math.min(fromRank, toRank));
  const hi = Math.min(Math.max(fromRank, toRank), order.slotOfRank.length - 1);
  if (hi < lo) return [];
  const slots = [...order.slotOfRank.subarray(lo, Math.min(hi + 1, lo + cap))];
  return idsForSlots(boardId, slots);
}

/** Image ids in the grid rectangle whose opposite corners are `fromRank`
 * and `toRank`. Unlike a linear rank range, cells outside the rectangle on
 * intervening rows are excluded. The caller supplies the result cap. */
export async function imageIdsInRankBand(
  boardId: string,
  sort: Sort,
  fromRank: number,
  toRank: number,
  cap: number,
): Promise<string[]> {
  const order = await rankOrder(boardId, sort);
  const fromCol = fromRank % COLS;
  const toCol = toRank % COLS;
  const loCol = Math.min(fromCol, toCol);
  const hiCol = Math.max(fromCol, toCol);
  const loRow = Math.floor(Math.min(fromRank, toRank) / COLS);
  const hiRow = Math.floor(Math.max(fromRank, toRank) / COLS);
  const slots: number[] = [];
  for (let row = loRow; row <= hiRow && slots.length < cap; row++) {
    for (let col = loCol; col <= hiCol && slots.length < cap; col++) {
      const rank = row * COLS + col;
      if (rank >= order.slotOfRank.length) break;
      slots.push(order.slotOfRank[rank] as number);
    }
  }
  return idsForSlots(boardId, slots);
}

/** Images in rank order, for `GET /boards/:id/images` — the click-to-image
 * lookup and the sheet-member picker both page through this. */
export async function imagesInRankOrder(
  boardId: string,
  sort: Sort,
  from: number,
  count: number,
): Promise<{ rank: number; imageId: string }[]> {
  const order = await rankOrder(boardId, sort);
  const start = Math.max(0, from);
  const slots = [
    ...order.slotOfRank.subarray(
      start,
      Math.min(start + count, order.slotOfRank.length),
    ),
  ];
  if (slots.length === 0) return [];
  const { rows } = await pool.query(
    'SELECT slot, id FROM images WHERE board_id = $1 AND slot = ANY($2::int[])',
    [boardId, slots],
  );
  return rows
    .map((row) => ({ rank: rankOf(order, row.slot), imageId: row.id }))
    .sort((a, b) => a.rank - b.rank);
}
