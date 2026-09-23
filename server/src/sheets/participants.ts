// Who has been in a sheet (CONTEXT.md "Thread"): the people whose stamps
// are on its claims (made or edited) and the people who replied to them,
// most recent first, five at most. Shown on the thread browser's rows.
//
// Stamps live in the stored scene (sheet_snapshots.elements, customData.
// made/edited), so this reads the last save, not the live room; a name
// comes from the user row when the person still exists, else from the
// stamp. `at` is compared as ISO text, which sorts in time order, so a
// malformed stamp cannot fail the query.
import type { Participant } from '@digsite/shared/api';
import { pool } from '../db/pool.ts';

export const PARTICIPANTS_SHOWN = 5;

export async function participantsOf(
  sheetIds: string[],
): Promise<Map<string, Participant[]>> {
  const out = new Map<string, Participant[]>();
  if (sheetIds.length === 0) return out;
  const { rows } = await pool.query<{
    sheet_id: string;
    id: string;
    name: string;
  }>(
    `WITH stamps AS (
       SELECT ss.sheet_id, st->>'id' AS id, st->>'name' AS name, st->>'at' AS at
       FROM sheet_snapshots ss
       CROSS JOIN LATERAL jsonb_array_elements(
         CASE WHEN jsonb_typeof(ss.elements) = 'array' THEN ss.elements ELSE '[]' END
       ) el
       CROSS JOIN LATERAL (VALUES (el->'customData'->'made'),
                                  (el->'customData'->'edited')) v(st)
       WHERE ss.sheet_id = ANY($1::uuid[])
         AND jsonb_typeof(st) = 'object' AND st ? 'id'
     ), replies AS (
       SELECT r.sheet_id, r.user_id AS id, NULL::text AS name,
         to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at
       FROM claim_replies r
       WHERE r.sheet_id = ANY($1::uuid[]) AND r.deleted_at IS NULL
     ), latest AS (
       SELECT sheet_id, id, max(name) AS name, max(at) AS at
       FROM (SELECT * FROM stamps UNION ALL SELECT * FROM replies) everyone
       GROUP BY sheet_id, id
     ), ranked AS (
       SELECT l.sheet_id, l.id, COALESCE(u.name, l.name, '') AS name,
         row_number() OVER (PARTITION BY l.sheet_id ORDER BY l.at DESC, l.id) AS n
       FROM latest l LEFT JOIN "user" u ON u.id = l.id
     )
     SELECT sheet_id, id, name FROM ranked WHERE n <= $2
     ORDER BY sheet_id, n`,
    [sheetIds, PARTICIPANTS_SHOWN],
  );
  for (const row of rows) {
    const list = out.get(row.sheet_id) ?? [];
    list.push({ id: row.id, name: row.name });
    out.set(row.sheet_id, list);
  }
  return out;
}
