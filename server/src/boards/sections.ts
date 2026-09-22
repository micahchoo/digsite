// GET /boards/:id/sections (docs/phases/1-map.md "Sections, hover,
// selection"): the rank ranges where a sort's grouping value changes. One
// query over board_ranks JOIN images, ordered by rank, using LAG() to find
// the boundaries — the same expression is both the grouping key and the
// display label (name: first letter uppercased; uploaded_at: the day;
// number/boolean/text property: the value as text), so no separate label
// step is needed. A property's absence sorts last (ranks.ts's NULLS LAST)
// and lands in one trailing section labelled "—".
import { type Sort, sortId } from '@digsite/shared/board/sort';
import { pool } from '../db/pool.ts';
import { ensureRank } from './ranks.ts';

const CAP = 500;

export type Section = { label: string; fromRank: number; toRank: number };

function sectionKeyExpr(sort: Sort): string {
  if (sort.key === 'name') return 'upper(left(i.name, 1))';
  if (sort.key === 'uploaded_at') return `to_char(i.uploaded_at, 'YYYY-MM-DD')`;
  // sort.key.property already passed parseSortId's PROPERTY_RE (alnum/_/-)
  // by the only two callers that build a Sort from a URL — same trust
  // boundary as ranks.ts#orderExpr; never build a Sort here from
  // unvalidated input.
  const { property } = sort.key;
  return `i.properties->>'${property}'`;
}

export async function sectionsFor(
  boardId: string,
  sort: Sort,
): Promise<{ sections: Section[]; truncated: boolean }> {
  await ensureRank(boardId, sort);
  const sid = sortId(sort);
  const keyExpr = sectionKeyExpr(sort);

  const { rows: boardRows } = await pool.query(
    'SELECT image_count FROM boards WHERE id = $1',
    [boardId],
  );
  const total = boardRows[0]?.image_count ?? 0;
  if (total === 0) return { sections: [], truncated: false };

  const { rows } = await pool.query(
    `WITH ordered AS (
       SELECT br.rank AS rank, ${keyExpr} AS key
       FROM board_ranks br
       JOIN images i ON i.board_id = br.board_id AND i.slot = br.slot
       WHERE br.board_id = $1 AND br.sort_id = $2
     )
     SELECT rank, key FROM (
       SELECT rank, key,
         key IS DISTINCT FROM LAG(key) OVER (ORDER BY rank) AS is_boundary
       FROM ordered
     ) b
     WHERE is_boundary
     ORDER BY rank
     LIMIT $3`,
    [boardId, sid, CAP + 1],
  );

  const truncated = rows.length > CAP;
  const kept = truncated ? rows.slice(0, CAP) : rows;
  const sections: Section[] = kept.map((row, idx) => {
    const next = rows[idx + 1];
    const toRank = next ? next.rank - 1 : total - 1;
    const label = row.key === null ? '—' : String(row.key);
    return { label, fromRank: row.rank, toRank };
  });

  return { sections, truncated };
}
