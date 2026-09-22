// One function per intent (CONTEXT.md "Intent"). Each takes (userId,
// objectId), returns the row, or throws AccessDenied(reason). Nothing else
// in the server reads `member`, `team` or `teamMember` — see
// .claude/rules/access-one-function-per-intent.md. The predicate is
// `member(user, group) AND (board.open OR member(user, allowlist))`,
// written here and nowhere else.
import type { Pool } from 'pg';
import { pool } from '../db/pool.ts';

export class AccessDenied extends Error {
  reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

function deny(reason: string): never {
  throw new AccessDenied(reason);
}

export type MemberRow = {
  id: string;
  organizationId: string;
  userId: string;
  role: string;
};

export type BoardRow = {
  id: string;
  org_id: string;
  name: string;
  open: boolean;
  team_id: string | null;
  created_by: string;
  default_sort: string;
  image_count: number;
  created_at: Date;
};

export type SheetRow = {
  id: string;
  board_id: string;
  name: string;
  created_by: string;
  created_at: Date;
};

export type ImageRow = {
  id: string;
  board_id: string;
  slot: number;
  sha256: string;
  name: string;
  width: number;
  height: number;
  uploaded_at: Date;
  uploaded_by: string;
  properties: Record<string, unknown>;
  missing: boolean;
};

async function findMember(
  db: Pool,
  userId: string,
  organizationId: string,
): Promise<MemberRow | null> {
  const { rows } = await db.query(
    `SELECT * FROM "member" WHERE "userId" = $1 AND "organizationId" = $2`,
    [userId, organizationId],
  );
  return rows[0] ?? null;
}

function isOwnerOrAdmin(member: MemberRow): boolean {
  const roles = member.role.split(',').map((r) => r.trim());
  return roles.includes('owner') || roles.includes('admin');
}

async function findBoard(db: Pool, boardId: string): Promise<BoardRow | null> {
  const { rows } = await db.query('SELECT * FROM boards WHERE id = $1', [
    boardId,
  ]);
  return rows[0] ?? null;
}

async function onTeam(
  db: Pool,
  userId: string,
  teamId: string,
): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM "teamMember" WHERE "userId" = $1 AND "teamId" = $2`,
    [userId, teamId],
  );
  return rows.length > 0;
}

export async function groupForViewing(
  userId: string,
  orgId: string,
  db: Pool = pool,
): Promise<MemberRow> {
  const member = await findMember(db, userId, orgId);
  if (!member) deny('not a member of this group');
  return member;
}

export async function groupForInviting(
  userId: string,
  orgId: string,
  db: Pool = pool,
): Promise<MemberRow> {
  const member = await findMember(db, userId, orgId);
  if (!member) deny('not a member of this group');
  if (!isOwnerOrAdmin(member)) deny('not owner or admin of this group');
  return member;
}

export async function boardForViewing(
  userId: string,
  boardId: string,
  db: Pool = pool,
): Promise<BoardRow> {
  const board = await findBoard(db, boardId);
  if (!board) deny('board not found');
  const member = await findMember(db, userId, board.org_id);
  if (!member) deny('not a member of this group');
  if (board.open) return board;
  if (board.team_id && (await onTeam(db, userId, board.team_id))) return board;
  deny('not on this private board');
}

export async function boardForUploading(
  userId: string,
  boardId: string,
  db: Pool = pool,
): Promise<BoardRow> {
  return boardForViewing(userId, boardId, db);
}

export async function boardForCreatingSheet(
  userId: string,
  boardId: string,
  db: Pool = pool,
): Promise<BoardRow> {
  return boardForViewing(userId, boardId, db);
}

export async function boardForManagingAllowlist(
  userId: string,
  boardId: string,
  db: Pool = pool,
): Promise<BoardRow> {
  const board = await boardForViewing(userId, boardId, db);
  if (board.created_by === userId) return board;
  const member = await findMember(db, userId, board.org_id);
  if (member && isOwnerOrAdmin(member)) return board;
  deny('not the board creator or an owner/admin of this group');
}

export async function boardForCreating(
  userId: string,
  orgId: string,
  db: Pool = pool,
): Promise<MemberRow> {
  const member = await findMember(db, userId, orgId);
  if (!member) deny('not a member of this group');
  return member;
}

export async function boardsForListing(
  userId: string,
  orgId: string,
  db: Pool = pool,
): Promise<BoardRow[]> {
  const member = await findMember(db, userId, orgId);
  if (!member) deny('not a member of this group');
  const { rows } = await db.query(
    `SELECT b.* FROM boards b
     WHERE b.org_id = $1
       AND (b.open OR EXISTS (
         SELECT 1 FROM "teamMember" tm WHERE tm."teamId" = b.team_id AND tm."userId" = $2
       ))
     ORDER BY b.created_at`,
    [orgId, userId],
  );
  return rows;
}

export async function sheetForEditing(
  userId: string,
  sheetId: string,
  db: Pool = pool,
): Promise<SheetRow> {
  const { rows } = await db.query('SELECT * FROM sheets WHERE id = $1', [
    sheetId,
  ]);
  const sheet = rows[0];
  if (!sheet) deny('sheet not found');
  await boardForViewing(userId, sheet.board_id, db);
  return sheet;
}

export async function imageForViewing(
  userId: string,
  imageId: string,
  db: Pool = pool,
): Promise<ImageRow> {
  const { rows } = await db.query('SELECT * FROM images WHERE id = $1', [
    imageId,
  ]);
  const image = rows[0];
  if (!image) deny('image not found');
  await boardForViewing(userId, image.board_id, db);
  return image;
}
