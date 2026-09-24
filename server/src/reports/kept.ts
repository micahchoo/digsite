// Kept and published reports (CONTEXT.md "Kept report", "Published
// report"): a report's data frozen with an id, what changed since, and the
// link that lets someone outside the group read it. Access is decided by
// the route before any of this is called (access/index.ts report* intents).
import { randomBytes, randomUUID } from 'node:crypto';
import {
  type ReportChanges,
  type ReportData,
  reportChanges,
} from '@digsite/shared';
import type { KeptReport } from '@digsite/shared/api';
import type { ReportRow } from '../access/index.ts';
import { pool } from '../db/pool.ts';
import { type GatherInput, gatherReport } from './gather.ts';

/** Gathers the report and keeps it; the data carries its new id. */
export async function keepReport(
  input: GatherInput,
  userId: string,
): Promise<ReportData> {
  const kept: ReportData = { ...(await gatherReport(input)), id: randomUUID() };
  const id = kept.id;
  await pool.query(
    `INSERT INTO reports (id, board_id, title, scope, data, made_by)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, input.boardId, kept.title, kept.scope, kept, userId],
  );
  return kept;
}

/** A board's kept reports, newest first. */
export async function reportsOn(boardId: string): Promise<KeptReport[]> {
  const { rows } = await pool.query(
    `SELECT r.id, r.title, r.scope, jsonb_array_length(r.data->'claims') AS claims,
            r.data->>'by' AS by, r.made_at, r.share_token IS NOT NULL AS linked,
            r.published_at, r.expires_at
       FROM reports r WHERE r.board_id = $1
      ORDER BY r.made_at DESC, r.id`,
    [boardId],
  );
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    scope: r.scope,
    claims: Number(r.claims),
    by: r.by,
    at: r.made_at.toISOString(),
    link:
      r.linked && r.published_at
        ? {
            publishedAt: r.published_at.toISOString(),
            expiresAt: r.expires_at ? r.expires_at.toISOString() : null,
          }
        : null,
  }));
}

/** The kept report's data, as it was kept. */
export function keptData(row: ReportRow): ReportData {
  return row.data as ReportData;
}

/** What the same scope says now, against what it said then. */
export async function changesSince(
  row: ReportRow,
  boardName: string,
): Promise<ReportChanges & { now: string }> {
  const kept = keptData(row);
  const now = await gatherReport({
    scope: kept.scope,
    boardId: row.board_id,
    boardName,
    by: kept.by,
    origin: kept.origin,
  });
  return { ...reportChanges(kept, now), now: now.at };
}

export async function removeReport(reportId: string): Promise<void> {
  await pool.query('DELETE FROM reports WHERE id = $1', [reportId]);
}

/** Days a link lasts unless the person publishing says otherwise; null
 * (never) is allowed only when asked for. */
export const LINK_DAYS = 30;
export const LINK_MAX_DAYS = 365;

/** A new link, replacing any earlier one: the old link stops working. */
export async function publishReport(
  reportId: string,
  userId: string,
  days: number | null,
): Promise<{ token: string; expiresAt: string | null }> {
  const token = randomBytes(32).toString('base64url');
  const { rows } = await pool.query<{ expires_at: Date | null }>(
    `UPDATE reports
        SET share_token = $2, published_by = $3, published_at = now(),
            expires_at = CASE WHEN $4::int IS NULL THEN NULL
                              ELSE now() + make_interval(days => $4::int) END
      WHERE id = $1
      RETURNING expires_at`,
    [reportId, token, userId, days],
  );
  const expires = rows[0]?.expires_at ?? null;
  return { token, expiresAt: expires ? expires.toISOString() : null };
}

export async function revokeLink(reportId: string): Promise<void> {
  await pool.query(
    `UPDATE reports SET share_token = NULL, published_by = NULL,
            published_at = NULL, expires_at = NULL
      WHERE id = $1`,
    [reportId],
  );
}
