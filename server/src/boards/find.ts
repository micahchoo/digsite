// GET /boards/:id/find?sort=&q=&filter= (docs/phases/6-product.md "Find and
// filter"): matches under the given sort, as ranks — never rebuilds
// board_ranks (joins the table `ensureRank` already maintains, same as
// every other rank reader in this directory).
import { type Sort, sortId } from '@digsite/shared/board/sort';
import { SHEET_LIMIT } from '@digsite/shared/sheet/elements';
import { pool } from '../db/pool.ts';
import { type FilterClause, buildFilterSql } from './filter.ts';
import { ensureRank } from './ranks.ts';

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
): Promise<FindResult> {
  await ensureRank(boardId, sort);
  const sid = sortId(sort);

  const params: unknown[] = [boardId, sid];
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

  const where = conditions.length ? `AND ${conditions.join(' AND ')}` : '';
  params.push(RANKS_CAP);
  const limitParam = params.length;

  const { rows } = await pool.query(
    `WITH matched AS (
       SELECT br.rank, i.id AS image_id
       FROM board_ranks br
       JOIN images i ON i.board_id = br.board_id AND i.slot = br.slot
       WHERE br.board_id = $1 AND br.sort_id = $2 ${where}
     )
     SELECT (SELECT COUNT(*) FROM matched) AS total,
       COALESCE((SELECT json_agg(rank ORDER BY rank)
         FROM (SELECT rank FROM matched ORDER BY rank LIMIT $${limitParam}) r), '[]'::json) AS ranks,
       COALESCE((SELECT json_agg(image_id ORDER BY rank)
         FROM (SELECT image_id, rank FROM matched ORDER BY rank LIMIT ${SHEET_LIMIT}) i), '[]'::json) AS image_ids`,
    params,
  );
  const row = rows[0];
  return {
    ranks: (row?.ranks ?? []) as number[],
    imageIds: (row?.image_ids ?? []) as string[],
    count: Number(row?.total ?? 0),
  };
}
