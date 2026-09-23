// Phase 6 (docs/phases/6-product.md "Group activity feed"): the one writer
// of `activity` rows, called from the four points the doc names — board
// created, images uploaded (batched per upload request, never one row per
// file), sheet started, member joined. Never reads `member`/`team`/
// `teamMember` (access/index.ts#activityForGroupListing decides who may see
// a row later; this module only records one).
import { pool } from '../db/pool.ts';

export type ActivityKind =
  | 'board_created'
  | 'images_uploaded'
  | 'sheet_started'
  | 'member_joined';

export async function recordActivity(
  groupId: string,
  boardId: string | null,
  kind: ActivityKind,
  actorId: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await pool.query(
    `INSERT INTO activity (group_id, board_id, kind, actor_id, payload)
     VALUES ($1, $2, $3, $4, $5)`,
    [groupId, boardId, kind, actorId, JSON.stringify(payload)],
  );
}
