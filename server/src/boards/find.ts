// GET /boards/:id/find?sort=&q=&filter= (docs/phases/6-product.md "Find and
// filter"): matches under the given sort, as ranks. Postgres filters the
// board's images; their ranks come from the sort's decoded order
// (ranks.ts#rankOrder). Measured on a 1,000,000-image board: 63 ms for
// 62,564 matches, where joining the old board_ranks table took 4.9 s.
import type { Sort } from '@digsite/shared/board/sort';
import { SHEET_LIMIT } from '@digsite/shared/sheet/elements';
import { termsMeaning } from '@digsite/shared/sheet/sense';
import { pool } from '../db/pool.ts';
import { type FilterClause, buildFilterSql } from './filter.ts';
import { rankOf, rankOrder } from './ranks.ts';
import { aliasesOf } from './vocabulary.ts';

/** Matches by what sheets have claimed about an image (CONTEXT.md "Making
 * sense"): a region with this label, an edge with this relation at either
 * end, or any claim at all. Terms match through aliases. */
export type ClaimFilter = {
  label?: string;
  relation?: string;
  annotated?: boolean;
};

const RANKS_CAP = 10_000;

let trgmCheck: Promise<boolean> | undefined;

/** Checked once per process. `pg_trgm` lets ILIKE '%term%' use a GIN index;
 * without it, the same ILIKE still works, just as a sequential scan — this
 * only decides whether we ALSO anchor the pattern to a prefix (`term%`,
 * which a plain btree can help with) when trigram support is absent, per
 * this task's own spec ("ILIKE with a trigram index if available, else
 * prefix"). Best-effort: `CREATE EXTENSION` needs a privilege the app's own
 * role may not have, so a failure here just means "not available" rather
 * than a request failing. */
async function trgmAvailableCached(): Promise<boolean> {
  // Cache the promise, not a flag set before the asynchronous probe. Find
  // requests arriving together must use the same substring-vs-prefix rule.
  trgmCheck ??= (async () => {
    try {
      const { rows } = await pool.query(
        `SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'`,
      );
      if (rows.length === 0) {
        await pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
      }
    } catch {
      return false;
    }

    // The extension may have been installed by a migration or another
    // process. Ensure the index in either case; index creation is only an
    // optimization and must not change substring-search semantics.
    try {
      await pool.query(
        'CREATE INDEX IF NOT EXISTS idx_images_name_trgm ON images USING gin (name gin_trgm_ops)',
      );
    } catch {
      // Keep substring matching even when this role cannot build the index.
    }
    return true;
  })();
  return trgmCheck;
}

export type FindResult = { ranks: number[]; imageIds: string[]; count: number };

export async function findRanks(
  boardId: string,
  sort: Sort,
  q: string | null,
  filter: FilterClause[],
  claims: ClaimFilter = {},
): Promise<FindResult> {
  const order = await rankOrder(boardId, sort);

  const params: unknown[] = [boardId];
  const conditions: string[] = [];

  const trimmedQ = (q ?? '').trim();
  if (trimmedQ) {
    const useSubstring = await trgmAvailableCached();
    const pattern = useSubstring ? `%${trimmedQ}%` : `${trimmedQ}%`;
    params.push(pattern);
    const qParam = params.length;
    conditions.push(
      `(i.name ILIKE $${qParam} OR EXISTS (
        SELECT 1 FROM jsonb_each_text(i.properties) kv WHERE kv.value ILIKE $${qParam}
      ))`,
    );
  }

  if (filter.length > 0) {
    const built = await buildFilterSql(boardId, filter, params.length + 1);
    conditions.push(`(${built.sql})`);
    params.push(...built.params);
  }

  if (claims.label || claims.relation) {
    const aliases = await aliasesOf(boardId);
    if (claims.label) {
      params.push(termsMeaning(claims.label, aliases.label));
      conditions.push(
        `EXISTS (SELECT 1 FROM regions r WHERE r.image_id = i.id AND r.label = ANY($${params.length}::text[]))`,
      );
    }
    if (claims.relation) {
      params.push(termsMeaning(claims.relation, aliases.relation));
      conditions.push(
        `EXISTS (SELECT 1 FROM edges e WHERE (e.src_image_id = i.id OR e.dst_image_id = i.id) AND e.relation = ANY($${params.length}::text[]))`,
      );
    }
  }
  if (claims.annotated) {
    conditions.push(
      `(EXISTS (SELECT 1 FROM regions r WHERE r.image_id = i.id)
        OR EXISTS (SELECT 1 FROM edges e WHERE e.src_image_id = i.id OR e.dst_image_id = i.id))`,
    );
  }

  const where = conditions.length ? `AND ${conditions.join(' AND ')}` : '';
  // Slots only, as array rows: a broad query can match most of a board,
  // and a uuid per match was most of the cost (872,133 matches: 7.6 s).
  const { rows } = await pool.query<[number]>({
    text: `SELECT i.slot FROM images i WHERE i.board_id = $1 ${where}`,
    values: params,
    rowMode: 'array',
  });
  // An image uploaded after this build has no rank yet; it is not on the
  // map, so it is not a match on it either.
  const ranks = new Int32Array(rows.length);
  let count = 0;
  for (const [slot] of rows) {
    const rank = rankOf(order, slot);
    if (rank >= 0) ranks[count++] = rank;
  }
  const sorted = ranks.subarray(0, count).sort();
  const first = [...sorted.subarray(0, SHEET_LIMIT)].map(
    (rank) => order.slotOfRank[rank] as number,
  );
  const { rows: idRows } = await pool.query(
    'SELECT slot, id FROM images WHERE board_id = $1 AND slot = ANY($2::int[])',
    [boardId, first],
  );
  const idOf = new Map(idRows.map((row) => [row.slot as number, row.id]));
  return {
    ranks: [...sorted.subarray(0, RANKS_CAP)],
    imageIds: first.map((slot) => idOf.get(slot) as string),
    count,
  };
}
