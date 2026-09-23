// GET /boards/:id/sections (docs/phases/1-map.md "Sections, hover,
// selection"): the rank ranges where a sort's grouping value changes. One
// query over images in the sort's own order (ranks.ts#orderExpr, the
// expression the rank build uses), with LAG() finding the boundaries and
// only boundary rows coming back — the same expression is both the grouping
// key and the
// display label (name: first letter uppercased; uploaded_at: the day;
// number/boolean/text property: the value as text), so no separate label
// step is needed. A property's absence sorts last (ranks.ts's NULLS LAST)
// and lands in one trailing section labelled "—".
import { type Sort, sortId } from '@digsite/shared/board/sort';
import { pool } from '../db/pool.ts';
import { type Build, type RankOrder, orderExpr } from './ranks.ts';

const CAP = 500;

export type Section = { label: string; fromRank: number; toRank: number };

function sectionKeyExpr(sort: Sort): string {
  if (sort.key === 'name') return 'upper(left(i.name, 1))';
  if (sort.key === 'uploaded_at') return `to_char(i.uploaded_at, 'YYYY-MM-DD')`;
  // The arrangement's group (meaning/arrangement.ts); named after the walk.
  if (sort.key === 'meaning') return 'i.meaning_group';
  // sort.key.property already passed parseSortId's PROPERTY_RE (alnum/_/-)
  // by the only two callers that build a Sort from a URL — same trust
  // boundary as ranks.ts#orderExpr; never build a Sort here from
  // unvalidated input.
  const { property } = sort.key;
  return `i.properties->>'${property}'`;
}

type Sections = { sections: Section[]; truncated: boolean };

// Sections depend only on the build: keyed by it, recomputed after the next.
// A sort of a million images costs 0.4-1.4 s to walk (2026-09-23).
const memo = new Map<string, { version: string; result: Sections }>();
const MEMO_ENTRIES = 256;

export async function sectionsFor({
  boardId,
  sort,
  order,
}: Build): Promise<Sections> {
  const key = `${boardId}:${sortId(sort)}`;
  const hit = memo.get(key);
  if (hit && hit.version === order.version) return hit.result;
  const result = await computeSections(boardId, sort, order);
  memo.delete(key);
  memo.set(key, { version: order.version, result });
  if (memo.size > MEMO_ENTRIES) memo.delete(memo.keys().next().value as string);
  return result;
}

async function computeSections(
  boardId: string,
  sort: Sort,
  order: RankOrder,
): Promise<Sections> {
  const total = order.slotOfRank.length;
  if (total === 0) return { sections: [], truncated: false };
  const keyExpr = sectionKeyExpr(sort);

  // Slots only grow, so `slot <= newest ranked` is exactly the images this
  // build ranked: an upload that has not been ranked yet cannot shift a
  // section away from the map.
  const { rows } = await pool.query(
    `SELECT rank, key FROM (
       SELECT (ROW_NUMBER() OVER w - 1)::int AS rank, ${keyExpr} AS key,
         ${keyExpr} IS DISTINCT FROM LAG(${keyExpr}) OVER w AS is_boundary
       FROM images i
       WHERE i.board_id = $1 AND i.slot < $2
       WINDOW w AS (ORDER BY ${orderExpr(sort)})
     ) b
     WHERE is_boundary
     ORDER BY rank
     LIMIT $3`,
    [boardId, order.rankOfSlot.length, CAP + 1],
  );

  const truncated = rows.length > CAP;
  const kept = truncated ? rows.slice(0, CAP) : rows;
  const sections: Section[] = kept.map((row, idx) => {
    const next = rows[idx + 1];
    const toRank = next ? next.rank - 1 : total - 1;
    const label = row.key === null ? '—' : String(row.key);
    return { label, fromRank: row.rank, toRank };
  });

  if (sort.key === 'meaning') await nameMeaningSections(boardId, sections);
  return { sections, truncated };
}

/** A meaning section's key is its group number; it is shown by the name
 * the arrangement gave the group (a label term), or as "Group n". */
async function nameMeaningSections(
  boardId: string,
  sections: Section[],
): Promise<void> {
  const { rows } = await pool.query(
    'SELECT grp, label FROM meaning_groups WHERE board_id = $1',
    [boardId],
  );
  const names = new Map(
    rows.map((r) => [String(r.grp), r.label as string | null]),
  );
  for (const section of sections) {
    if (section.label === '—') continue;
    section.label =
      names.get(section.label) ?? `Group ${Number(section.label) + 1}`;
  }
}
