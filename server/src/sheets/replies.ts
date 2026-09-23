// CONTEXT.md "Reply": what people say about a claim, beside it. Append-only
// (0023_claim_replies.sql). A sheet's replies are read whole, because a
// sheet holds at most a few hundred claims and the inspector shows counts.
import type { ClaimReply } from '@digsite/shared/api';
import { pool } from '../db/pool.ts';

export const REPLY_MAX_CHARS = 2000;

type Row = {
  id: string;
  element_id: string;
  user_id: string;
  user_name: string | null;
  body: string;
  created_at: Date;
};

const toReply = (row: Row): ClaimReply => ({
  id: row.id,
  elementId: row.element_id,
  by: { id: row.user_id, name: row.user_name || 'Someone' },
  text: row.body,
  at: row.created_at.toISOString(),
});

/** Every live reply on a sheet's claims, oldest first. */
export async function repliesOn(sheetId: string): Promise<ClaimReply[]> {
  const { rows } = await pool.query<Row>(
    `SELECT r.id, r.element_id, r.user_id, u.name AS user_name, r.body, r.created_at
       FROM claim_replies r
       LEFT JOIN "user" u ON u.id = r.user_id
      WHERE r.sheet_id = $1 AND r.deleted_at IS NULL
      ORDER BY r.created_at, r.id`,
    [sheetId],
  );
  return rows.map(toReply);
}

/** Adds a reply; the text is trimmed and must be 1..REPLY_MAX_CHARS. */
export async function addReply(
  boardId: string,
  sheetId: string,
  elementId: string,
  userId: string,
  text: string,
): Promise<ClaimReply> {
  const { rows } = await pool.query<Row>(
    `WITH added AS (
       INSERT INTO claim_replies (board_id, sheet_id, element_id, user_id, body)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, element_id, user_id, body, created_at
     )
     SELECT a.*, u.name AS user_name FROM added a LEFT JOIN "user" u ON u.id = a.user_id`,
    [boardId, sheetId, elementId, userId, text],
  );
  const row = rows[0];
  if (!row) throw new Error('reply not stored');
  return toReply(row);
}

/** Marks the reply deleted when `userId` wrote it. False when there is no
 * such live reply by them on this sheet. */
export async function removeReply(
  sheetId: string,
  replyId: string,
  userId: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE claim_replies SET deleted_at = now()
      WHERE id = $1 AND sheet_id = $2 AND user_id = $3 AND deleted_at IS NULL`,
    [replyId, sheetId, userId],
  );
  return (rowCount ?? 0) > 0;
}
