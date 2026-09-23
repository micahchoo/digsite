// One function per intent (CONTEXT.md "Intent"). Each takes (userId,
// objectId), returns the row, or throws AccessDenied(reason). Nothing else
// in the server reads `member`, `team` or `teamMember` — see
// .claude/rules/access-one-function-per-intent.md. The predicate is
// `member(user, group) AND (board.open OR member(user, allowlist))`,
// written here and nowhere else.
import type { Pool } from 'pg';
import { pool } from '../db/pool.ts';

// Phase 6 (docs/ux/audit.md #7, docs/ux/design.md's error copy): a board
// denial names whom to ask ONLY when the viewer is a member of the board's
// group — a group member may know a private board exists at all; a
// non-member must learn nothing (this file's own "existence must not
// leak"). `askName` is optional and carried on the error itself, decided
// here (never in a route), so http.ts's one catch site is the only place
// that turns it into JSON.
export class AccessDenied extends Error {
  reason: string;
  askName?: string;
  constructor(reason: string, askName?: string) {
    super(reason);
    this.reason = reason;
    this.askName = askName;
  }
}

function deny(reason: string, askName?: string): never {
  throw new AccessDenied(reason, askName);
}

async function creatorNameOf(
  db: Pool,
  userId: string,
): Promise<string | undefined> {
  const { rows } = await db.query('SELECT name FROM "user" WHERE id = $1', [
    userId,
  ]);
  return rows[0]?.name ?? undefined;
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
  // Phase 1 (docs/phases/1-map.md "Upload as a worker"): 0/0 and 'pending'
  // until worker/jobs.ts#runLadderJob decodes the original and sets these.
  status: 'ready' | 'pending' | 'failed';
  error: string | null;
  /** The phone or camera file this JPEG came from (0026_image_sources). */
  source_sha256: string | null;
  source_format: string | null;
  source_bytes: string | null;
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
  // The viewer IS a member of the board's group (checked above) — they may
  // already know this board exists (it can appear named in another
  // member's activity, a link pasted in chat, and so on), so naming who to
  // ask is not a new leak. `groupForViewing`'s own denial (not a member at
  // all) never reaches this line.
  deny('not on this private board', await creatorNameOf(db, board.created_by));
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

/** Declaring that one term means another (CONTEXT.md "Alias"). Anyone who
 * can see the board may: an alias changes how claims are READ, never a
 * claim, and every member may already draw claims here. */
export async function boardForAliasing(
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

/** CONTEXT.md "Reply": anyone who can see the board may discuss any claim
 * on it, on any sheet, including a sheet they would only see as foreign
 * claims. A reply says something about a claim; it never changes one. */
export async function sheetForDiscussing(
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

// -- Phase 3 (docs/phases/3-groups.md): four new intents. Every route that
// manages members, or deletes a board/sheet/image, names one of these — see
// .claude/rules/access-one-function-per-intent.md.

/** PATCH/DELETE /groups/:id/members/:userId. Owner or admin — the plugin's
 * own update-member-role/remove-member endpoints separately refuse a
 * non-owner touching an owner (crud-members.mjs), so this intent only gates
 * "may touch members of this group at all", same predicate as
 * groupForInviting. */
export async function groupForManagingMembers(
  userId: string,
  orgId: string,
  db: Pool = pool,
): Promise<MemberRow> {
  return groupForInviting(userId, orgId, db);
}

/** PATCH/DELETE /boards/:id, GET /boards/:id/footprint — creator or org
 * owner/admin, same predicate as boardForManagingAllowlist (an owner/admin
 * not on a private board's allowlist still cannot delete it — ownership
 * does not bypass the allowlist, CONTEXT.md). */
export async function boardForDeleting(
  userId: string,
  boardId: string,
  db: Pool = pool,
): Promise<BoardRow> {
  return boardForManagingAllowlist(userId, boardId, db);
}

/** DELETE /sheets/:id, GET /sheets/:id/footprint — the sheet's own creator,
 * or the board's manager (boardForDeleting's predicate). Must be able to
 * view the board at all first. */
export async function sheetForDeleting(
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
  if (sheet.created_by === userId) return sheet;
  try {
    await boardForManagingAllowlist(userId, sheet.board_id, db);
    return sheet;
  } catch (err) {
    if (err instanceof AccessDenied) {
      deny("not the sheet creator or the board's manager");
    }
    throw err;
  }
}

/** DELETE /images/:id — same rule as boardForDeleting, applied to the
 * image's board. */
export async function imageForDeleting(
  userId: string,
  imageId: string,
  db: Pool = pool,
): Promise<ImageRow> {
  const { rows } = await db.query('SELECT * FROM images WHERE id = $1', [
    imageId,
  ]);
  const image = rows[0];
  if (!image) deny('image not found');
  await boardForDeleting(userId, image.board_id, db);
  return image;
}

// -- Phase 6 (docs/phases/6-product.md): three new listing intents, same
// "boardsForListing is one query" discipline (this file's own comment on
// that function) — a private board the viewer is not on is ABSENT from
// every one of these, never filtered client-side or looped per-board.

export type GroupSheetRow = {
  id: string;
  board_id: string;
  board_name: string;
  name: string;
  created_at: Date;
  archived: boolean;
  image_count: string; // numeric from COUNT(*), caller casts
  saved_at: Date | null;
  last_activity_at: Date;
  seen_at: Date | null;
  preview_image_ids: string[];
};

/** GET /groups/:id/sheets (docs/phases/6-product.md "Sheets are threads"):
 * every sheet of every board the viewer can see in the group, one query —
 * the open-or-allowlist predicate joined straight against `sheets`, plus
 * this user's own `sheet_reads` row per sheet (so "unread" is computed here
 * rather than the route re-deriving membership to ask for it separately). */
export async function sheetsForGroupListing(
  userId: string,
  orgId: string,
  includeArchived = false,
  db: Pool = pool,
): Promise<GroupSheetRow[]> {
  const member = await findMember(db, userId, orgId);
  if (!member) deny('not a member of this group');
  const { rows } = await db.query(
    `SELECT s.id, s.board_id, b.name AS board_name, s.name, s.created_at, s.archived,
       (SELECT COUNT(*) FROM sheet_images si WHERE si.sheet_id = s.id) AS image_count,
       ss.saved_at, COALESCE(ss.saved_at, s.created_at) AS last_activity_at, sr.seen_at,
       COALESCE((
         SELECT array_agg(t.image_id) FROM (
           SELECT si.image_id FROM sheet_images si
           JOIN images i ON i.id = si.image_id
           WHERE si.sheet_id = s.id ORDER BY i.slot LIMIT 4
         ) t
       ), '{}') AS preview_image_ids
     FROM sheets s
     JOIN boards b ON b.id = s.board_id
     LEFT JOIN sheet_snapshots ss ON ss.sheet_id = s.id
     LEFT JOIN sheet_reads sr ON sr.sheet_id = s.id AND sr.user_id = $2
     WHERE b.org_id = $1 AND ($3::boolean OR s.archived = false)
       AND (b.open OR EXISTS (
         SELECT 1 FROM "teamMember" tm WHERE tm."teamId" = b.team_id AND tm."userId" = $2
       ))
     ORDER BY COALESCE(ss.saved_at, s.created_at) DESC`,
    [orgId, userId, includeArchived],
  );
  return rows;
}

export type ActivityRow = {
  id: string;
  group_id: string;
  board_id: string | null;
  kind: string;
  actor_id: string;
  actor_name: string;
  payload: Record<string, unknown>;
  at: Date;
};

/** GET /groups/:id/activity (docs/phases/6-product.md "Group activity
 * feed"): the guestbook. `board_id IS NULL` rows (a member joining) are
 * group-level and visible to every member; a board-scoped row is filtered
 * by the same open-or-allowlist predicate as everywhere else, so a viewer
 * never learns a private board they're not on exists via its own history. */
export async function activityForGroupListing(
  userId: string,
  orgId: string,
  limit: number,
  db: Pool = pool,
): Promise<ActivityRow[]> {
  const member = await findMember(db, userId, orgId);
  if (!member) deny('not a member of this group');
  const { rows } = await db.query(
    `SELECT a.id, a.group_id, a.board_id, a.kind, a.actor_id, u.name AS actor_name,
       a.payload, a.at
     FROM activity a
     LEFT JOIN boards b ON b.id = a.board_id
     JOIN "user" u ON u.id = a.actor_id
     WHERE a.group_id = $1
       AND (a.board_id IS NULL OR b.open OR EXISTS (
         SELECT 1 FROM "teamMember" tm WHERE tm."teamId" = b.team_id AND tm."userId" = $2
       ))
     ORDER BY a.at DESC
     LIMIT $3`,
    [orgId, userId, limit],
  );
  return rows;
}

export type GroupBoardStats = { images: number; sheets: number };

/** GET /groups/:id/stats (docs/phases/6-product.md "visitor counter"):
 * images/sheets summed over visible boards only — `membersOfGroup`
 * (access/reads.ts) supplies the member count separately, same split as
 * every other listing route (this function decides visibility; a plain
 * membership-table read for display is reads.ts's job). */
export async function statsForGroupListing(
  userId: string,
  orgId: string,
  db: Pool = pool,
): Promise<GroupBoardStats> {
  const member = await findMember(db, userId, orgId);
  if (!member) deny('not a member of this group');
  const { rows } = await db.query(
    `WITH visible AS (
       SELECT b.id, b.image_count FROM boards b
       WHERE b.org_id = $1
         AND (b.open OR EXISTS (
           SELECT 1 FROM "teamMember" tm WHERE tm."teamId" = b.team_id AND tm."userId" = $2
         ))
     )
     SELECT
       (SELECT COALESCE(SUM(image_count), 0) FROM visible) AS images,
       (SELECT COUNT(*) FROM sheets WHERE board_id IN (SELECT id FROM visible)) AS sheets`,
    [orgId, userId],
  );
  return {
    images: Number(rows[0]?.images ?? 0),
    sheets: Number(rows[0]?.sheets ?? 0),
  };
}
