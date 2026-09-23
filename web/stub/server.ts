// A throwaway dev stub — enough of docs/design.md's server contract (plus
// docs/phases/3-groups.md's web/ section) to drive every web/ page without
// the real server running. Not product code. Reuses @digsite/shared
// wherever the real server would (grid math, fractions, project()), so the
// fixture stays honest about the contract.
import { createServer } from 'node:http';
import {
  type Aliases,
  COLS,
  type EdgeRow,
  type FindFilterClause,
  SHEET_LIMIT,
  type SceneElement,
  type Sort,
  type TermKind,
  arrowheadsFor,
  buildVocabulary,
  cellPx,
  fileId,
  fromFraction,
  imageGroupId,
  parseSortId,
  project,
  termsMeaning,
  tileRanks,
  withAlias,
} from '@digsite/shared';
import { createCanvas } from '@napi-rs/canvas';
import { type Socket, Server as SocketServer } from 'socket.io';
import { centreToTopLeft, fitScale } from '../src/board/explore-layout.ts';

const PORT = Number(process.env.PORT) || 8800;
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5180';
const IMAGE_COUNT = 60;
// Slice 2: board b4's own image count — strictly more than SHEET_LIMIT so
// "Start a sheet" can genuinely be asked to truncate.
const BIG_BOARD_IMAGE_COUNT = SHEET_LIMIT + 12;
const COOKIE_PREFIX = 'digsite.stub_session';
// The worker's pending -> ready delay (docs/phases/1-map.md section 1). Real
// uploads accept at 202 and flip to ready once the ladder is painted; here
// that's just a timer.
const READY_DELAY_MS = 1000;
// Matches server/src/sheets/routes.ts's own CELL — the grid-fallback
// spacing for a sheet-from-a-neighbourhood whose image has no explicit
// `positions` centre (see the ids-vs-neighbourhood POST /boards/:id/sheets
// handler below). SHEET_FIT lives in ../src/board/explore-layout.ts
// (imported as `fitScale`'s default) since that half is unit-tested.
const SHEET_CELL = 320;

const range = (a: number, b: number): number[] =>
  Array.from({ length: b - a }, (_, i) => a + i);

// -- users, groups, roles ----------------------------------------------------
// Five fixed users, matching ../../prototype/groups/CONTRACT.md's matrix
// (extended with `admin`, which phase 3's role-management intent needs and
// the prototype did not have). All five, `outsider` excepted, start in
// group "Lab"; sign-in picks the user by the local part of the email, so
// the existing smoke scripts (which only ever sign in as `owner`) are
// unaffected and a new script gets the other four for free with no UI
// changes — `?as=` on sign-in was the alternative docs/phases/3-groups.md
// offered; this needs no new query param or header.
type UserKey = 'owner' | 'admin' | 'member' | 'listed' | 'outsider';
const USERS: Record<UserKey, { id: string; email: string; name: string }> = {
  owner: { id: 'u1', email: 'owner@example.test', name: 'Owner' },
  admin: { id: 'u2', email: 'admin@example.test', name: 'Admin' },
  member: { id: 'u3', email: 'member@example.test', name: 'Member' },
  listed: { id: 'u4', email: 'listed@example.test', name: 'Listed' },
  outsider: { id: 'u5', email: 'outsider@example.test', name: 'Outsider' },
};
const USER_KEYS = Object.keys(USERS) as UserKey[];
type GroupRole = 'owner' | 'admin' | 'member';
// docs/ux/audit.md #8 (shell) needs a second group in the rail, and the
// shell agent's own finding: every `/groups/:id/*` route used to ignore
// `:id` entirely, always answering for one hardcoded group regardless of
// what was in the URL — a garbage id was never a 404, it silently behaved
// as `g1`. Fixed by keying everything (membership, boards) by group id, the
// same way boards are already keyed by board id.
//
// `GROUP_ROLES[groupId]` partial: a key absent means that user is not in
// that group. `outsider` starts absent from `g1` — the join page's happy
// path signs them up and accepts an invitation, which adds the key (see
// /invitations/:id/accept). `g2` ("Annex") exists only for `owner`, so the
// shell has a real second group to switch to without disturbing `g1`'s
// fixture, which every other smoke script depends on unchanged.
interface Group {
  id: string;
  name: string;
}
const GROUPS: Record<string, Group> = {
  g1: { id: 'g1', name: 'Lab' },
  g2: { id: 'g2', name: 'Annex' },
};
const GROUP_ROLES: Record<string, Partial<Record<UserKey, GroupRole>>> = {
  g1: { owner: 'owner', admin: 'admin', member: 'member', listed: 'member' },
  g2: { owner: 'owner' },
};

function groupOf(groupId: string): Group | null {
  return GROUPS[groupId] ?? null;
}
function roleOf(u: UserKey, groupId: string): GroupRole | undefined {
  return GROUP_ROLES[groupId]?.[u];
}
/** The mutable role map for a group, created on first write — every
 * membership WRITE (accept, role change, remove, leave) goes through this
 * instead of an inline `??=` (biome's noAssignInExpressions). */
function rolesOf(groupId: string): Partial<Record<UserKey, GroupRole>> {
  let roles = GROUP_ROLES[groupId];
  if (!roles) {
    roles = {};
    GROUP_ROLES[groupId] = roles;
  }
  return roles;
}

function keyForUserId(userId: string): UserKey | null {
  return USER_KEYS.find((k) => USERS[k].id === userId) ?? null;
}
/** Reads the stub's session cookie out of a raw `Cookie` header string.
 * Not typed against `IncomingMessage` — bun's bundled node:http typings
 * give the request listener's own `req` an extra member that a standalone
 * `IncomingMessage` annotation doesn't carry (see this file's header
 * comment on `json`/`cors`), so this takes the header value itself and is
 * called as `sessionUser(req.headers.cookie)`. */
function sessionUser(cookieHeader: string | undefined): UserKey | null {
  const cookie = cookieHeader ?? '';
  const m = cookie.match(new RegExp(`${COOKIE_PREFIX}=([a-z]+)`));
  const key = m?.[1] as UserKey | undefined;
  return key && USERS[key] ? key : null;
}
function currentMembers(groupId: string) {
  return USER_KEYS.filter((k) => GROUP_ROLES[groupId]?.[k]).map((k) => ({
    userId: USERS[k].id,
    email: USERS[k].email,
    name: USERS[k].name,
    role: GROUP_ROLES[groupId]?.[k] as GroupRole,
  }));
}

// -- boards, allowlists -------------------------------------------------------
interface Board {
  id: string;
  name: string;
  open: boolean;
  imageCount: number;
  createdBy: UserKey;
  defaultSort: string;
  groupId: string;
}
const BOARDS: Board[] = [
  {
    id: 'b1',
    name: 'Field',
    open: true,
    imageCount: IMAGE_COUNT,
    createdBy: 'member',
    defaultSort: 'uploaded_at.desc',
    groupId: 'g1',
  },
  {
    id: 'b2',
    name: 'Finds',
    open: false,
    imageCount: 0,
    createdBy: 'admin',
    defaultSort: 'uploaded_at.desc',
    groupId: 'g1',
  },
  // The shell's second group needs at least one board so its channel
  // column isn't indistinguishable from a broken fetch.
  {
    id: 'b3',
    name: 'Annex board',
    open: true,
    imageCount: 0,
    createdBy: 'owner',
    defaultSort: 'uploaded_at.desc',
    groupId: 'g2',
  },
  // Slice 2 (docs/ux/design.md §7, §5.1 "Over the cap"): the only board
  // with more images than SHEET_LIMIT (150), so smoke-selection.ts can
  // exercise "Start a sheet with the first 150 of N" against a real
  // selection instead of faking the count. Own id namespace (`img-big-*`,
  // below) so it never collides with b1's `img-<slot>` ids.
  {
    id: 'b4',
    name: 'Big',
    open: true,
    imageCount: BIG_BOARD_IMAGE_COUNT,
    createdBy: 'owner',
    defaultSort: 'uploaded_at.desc',
    groupId: 'g1',
  },
];
// Finds' allowlist deliberately excludes `owner` — the prototype's matrix:
// "an owner not on a private board's allowlist is denied. Ownership does
// not bypass the allowlist" (../.claude/rules/access-one-function-per-intent.md).
const ALLOWLIST: Record<string, Set<UserKey>> = {
  b2: new Set<UserKey>(['admin', 'listed']),
};
let boardSeq = BOARDS.length + 1;

// -- selection (docs/ux/design.md §7 slice 2 / docs/phases/6-product.md
// "Selection"): a set of image ids per (board, viewer), saved server-side —
// survives sort/filter/zoom/reload. Keyed by `${boardId}:${userId}`;
// `imageIds` order is tray order (design.md §5.1). ---------------------
const SELECTIONS: Record<string, string[]> = {};
function selectionKey(boardId: string, userId: string): string {
  return `${boardId}:${userId}`;
}
const SELECTION_RANGE_CAP = 5000;

// -- access: one predicate per intent, mirroring server/src/access/index.ts
// (../.claude/rules/access-one-function-per-intent.md) so the stub's rules
// are encoded exactly once and every route below calls one of these. ------
type Denied = { reason: string };
function boardOf(boardId: string): Board | null {
  return BOARDS.find((b) => b.id === boardId) ?? null;
}
function isMember(u: UserKey, groupId: string): boolean {
  return !!GROUP_ROLES[groupId]?.[u];
}
function groupForViewing(u: UserKey, groupId: string): Denied | null {
  if (!groupOf(groupId)) return null; // the route decides not-found, after access
  return isMember(u, groupId) ? null : { reason: 'not a member of this group' };
}
function groupForInviting(u: UserKey, groupId: string): Denied | null {
  const g = groupForViewing(u, groupId);
  if (g) return g;
  const role = roleOf(u, groupId);
  return role === 'owner' || role === 'admin'
    ? null
    : { reason: 'must be a group owner or admin' };
}
const groupForManagingMembers = groupForInviting;
function boardForViewing(u: UserKey, boardId: string): Denied | null {
  const board = boardOf(boardId);
  if (!board) return null; // the route decides not-found, after access
  const g = groupForViewing(u, board.groupId);
  if (g) return g;
  if (board.open) return null;
  return ALLOWLIST[boardId]?.has(u) ? null : { reason: 'not on the allowlist' };
}
function isBoardManager(u: UserKey, boardId: string): boolean {
  const board = boardOf(boardId);
  if (!board) return false;
  if (board.createdBy === u) return true;
  const role = roleOf(u, board.groupId);
  return role === 'owner' || role === 'admin';
}
function boardForManagingAllowlist(u: UserKey, boardId: string): Denied | null {
  const v = boardForViewing(u, boardId);
  if (v) return v;
  return isBoardManager(u, boardId)
    ? null
    : { reason: 'must be the board creator or a group owner/admin' };
}
// Rename and delete share the "creator or group owner/admin" rule
// (docs/phases/3-groups.md section 4).
const boardForDeleting = boardForManagingAllowlist;
const boardForRenaming = boardForManagingAllowlist;
function sheetForDeleting(u: UserKey, sheetId: string): Denied | null {
  const boardId = SHEET_BOARD[sheetId] ?? 'b1';
  const v = boardForViewing(u, boardId);
  if (v) return v;
  if (SHEET_CREATOR[sheetId] === u) return null;
  return isBoardManager(u, boardId)
    ? null
    : { reason: "must be the sheet creator or the board's manager" };
}
function imageForDeleting(u: UserKey, boardId: string): Denied | null {
  return boardForDeleting(u, boardId);
}

// Matches @digsite/shared/api's BoardImage.status now that it has landed
// there (three states: the ladder job can also fail after its retries).
// The stub never produces 'failed' — nothing here decodes real image bytes.
type ImageStatus = 'pending' | 'ready' | 'failed';
interface Img {
  id: string;
  boardId: string;
  slot: number;
  name: string;
  width: number;
  height: number;
  uploadedAt: string;
  properties: Record<string, string | number | boolean>;
  missing: boolean;
  status: ImageStatus;
  error: string | null;
}
const makeImg = (
  boardId: string,
  slot: number,
  opts?: { idPrefix?: string; count?: number },
): Img => ({
  id: `${opts?.idPrefix ?? 'img'}-${slot}`,
  boardId,
  slot,
  name: `image-${slot}`,
  width: 256,
  height: 256,
  uploadedAt: new Date(
    Date.now() - ((opts?.count ?? IMAGE_COUNT) - slot) * 60_000,
  ).toISOString(),
  properties: { year: 1900 + (slot % 60), site: `site-${slot % 5}` },
  missing: false,
  status: 'ready',
  error: null,
});
let images: Img[] = [
  ...range(0, IMAGE_COUNT).map((slot) => makeImg('b1', slot)),
  // b4 ("Big"): own id namespace so it never collides with b1's `img-N`.
  ...range(0, BIG_BOARD_IMAGE_COUNT).map((slot) =>
    makeImg('b4', slot, { idPrefix: 'img-big', count: BIG_BOARD_IMAGE_COUNT }),
  ),
];

const SORTABLE_KEYS = [
  { key: 'name' as const, label: 'name' },
  { key: 'uploaded_at' as const, label: 'uploaded' },
  { key: { property: 'year', type: 'number' as const }, label: 'year' },
  { key: { property: 'site', type: 'text' as const }, label: 'site' },
];

function rankedImages(boardId: string, sort: Sort): Img[] {
  const dir = sort.dir === 'asc' ? 1 : -1;
  const key = sort.key;
  const value = (img: Img): string | number =>
    key === 'name'
      ? img.name
      : key === 'uploaded_at'
        ? img.uploadedAt
        : ((img.properties as Record<string, string | number>)[key.property] ??
          '');
  return images
    .filter((i) => i.boardId === boardId)
    .sort((a, b) => {
      const va = value(a);
      const vb = value(b);
      return va < vb ? -dir : va > vb ? dir : a.slot - b.slot;
    });
}

const SECTIONS_CAP = 500;

/** GET /boards/:id/sections?sort=<sortId> — boundaries where the sorted
 * value changes: name's first letter, uploaded_at's day, a property's raw
 * value (docs/phases/1-map.md section 3). */
function sectionValue(sort: Sort, img: Img): string {
  const key = sort.key;
  if (key === 'name') return img.name.charAt(0).toUpperCase();
  if (key === 'uploaded_at') return img.uploadedAt.slice(0, 10);
  const raw = (img.properties as Record<string, string | number>)[key.property];
  return raw === undefined ? '' : String(raw);
}

function computeSections(
  boardId: string,
  sort: Sort,
): {
  sections: { label: string; fromRank: number; toRank: number }[];
  truncated: boolean;
} {
  const ranked = rankedImages(boardId, sort);
  const sections: { label: string; fromRank: number; toRank: number }[] = [];
  let currentLabel: string | null = null;
  let fromRank = 0;
  ranked.forEach((img, i) => {
    const label = sectionValue(sort, img);
    if (currentLabel === null) {
      currentLabel = label;
      fromRank = i;
    } else if (label !== currentLabel) {
      sections.push({ label: currentLabel, fromRank, toRank: i - 1 });
      currentLabel = label;
      fromRank = i;
    }
  });
  if (currentLabel !== null) {
    sections.push({
      label: currentLabel,
      fromRank,
      toRank: ranked.length - 1,
    });
  }
  const truncated = sections.length > SECTIONS_CAP;
  return { sections: sections.slice(0, SECTIONS_CAP), truncated };
}

// -- sheets: two, sharing a region+edge pair on images 8 & 9 ----------------
const SHEET_IMAGES: {
  s1: number[];
  s2: number[];
  [sheetId: string]: number[];
} = {
  s1: range(0, 12),
  s2: range(6, 18),
};
const SHEET_NAME: Record<string, string> = { s1: 'First pass', s2: 'Faces' };
const SHEET_ARCHIVED = new Set<string>();
const SHEET_READS = new Map<string, string>();
const SHEET_CREATED_AT = new Date().toISOString();
const SHEET_BOARD: Record<string, string> = { s1: 'b1', s2: 'b1' };
// Neither seed sheet's creator is a board manager of Field (created_by
// `member`) — `listed` deleting s1 is a real 403, not a vacuous one.
const SHEET_CREATOR: Record<string, UserKey> = { s1: 'member', s2: 'listed' };
let sheetSeq = 3;

// biome-ignore lint/suspicious/noExplicitAny: minimal scene fixtures; the canvas fills optional fields client-side
const el = (partial: Record<string, unknown>): any => ({
  version: 1,
  versionNonce: 1,
  isDeleted: false,
  updated: Date.now(),
  ...partial,
});

function grid(imageIds: string[]): SceneElement[] {
  return imageIds.map((id, i) =>
    el({
      id: `seed-img-${id}`,
      type: 'image',
      x: (i % 5) * 320,
      y: Math.floor(i / 5) * 320,
      width: 256,
      height: 256,
      fileId: fileId(id),
      customData: { kind: 'image', imageId: id },
      groupIds: [imageGroupId(id)],
    }),
  );
}

/** Sheet s1's seed, plus one region on images 8 and 9 and an edge between
 * them — what s2 (which also holds 8 and 9) sees as foreign. */
function seedS1(): SceneElement[] {
  const els = grid(SHEET_IMAGES.s1.map((slot) => `img-${slot}`));
  const img8 = els.find(
    (e) => (e.customData as { imageId?: string })?.imageId === 'img-8',
  );
  const img9 = els.find(
    (e) => (e.customData as { imageId?: string })?.imageId === 'img-9',
  );
  if (!img8 || !img9) return els;

  const rect8 = fromFraction({ fx: 0.1, fy: 0.1, fw: 0.35, fh: 0.35 }, img8);
  const rect9 = fromFraction({ fx: 0.5, fy: 0.5, fw: 0.3, fh: 0.3 }, img9);
  const region = (
    id: string,
    imageId: string,
    rect: typeof rect8,
    label: string,
  ) =>
    el({
      id,
      type: 'rectangle',
      ...rect,
      groupIds: [imageGroupId(imageId)],
      customData: { kind: 'region', imageId, label, properties: {} },
    });
  const region8 = region('seed-region-8', 'img-8', rect8, 'find');
  const region9 = region('seed-region-9', 'img-9', rect9, 'fragment');

  const heads = arrowheadsFor('forward');
  const [ax, ay] = [rect8.x + rect8.width / 2, rect8.y + rect8.height / 2];
  const [bx, by] = [rect9.x + rect9.width / 2, rect9.y + rect9.height / 2];
  const edge = el({
    id: 'seed-edge-8-9',
    type: 'arrow',
    x: ax,
    y: ay,
    width: Math.abs(bx - ax) || 1,
    height: Math.abs(by - ay) || 1,
    points: [
      [0, 0],
      [bx - ax, by - ay],
    ],
    startArrowhead: heads.startArrowhead,
    endArrowhead: heads.endArrowhead,
    startBinding: { elementId: 'seed-region-8' },
    endBinding: { elementId: 'seed-region-9' },
    customData: {
      kind: 'edge',
      relation: 'resembles',
      direction: 'forward',
      properties: {},
    },
  });
  return [...els, region8, region9, edge];
}

const elementsBySheet: Record<string, SceneElement[]> = {
  s1: seedS1(),
  s2: grid(SHEET_IMAGES.s2.map((slot) => `img-${slot}`)),
};
// socketId -> {id, name} — a name per peer (docs/phases/2-sheet.md section
// 3: "the status line shows names"), same shape as the real room.ts.
const peersBySheet: Record<
  string,
  Map<string, { id: string; name: string }>
> = {
  s1: new Map(),
  s2: new Map(),
};
// GET /boards/:id/sheets "savedAt" (docs/phases/2-sheet.md section 6) — the
// stub's stand-in for sheet_snapshots.saved_at, bumped on every 'scene'
// broadcast, same as the real server's debounced snapshot would be.
const sheetSavedAt: Record<string, string> = {
  s1: new Date().toISOString(),
  s2: new Date().toISOString(),
};
const stats = { scenes: 0, broadcasts: 0, snapshots: 0, lastProjectionMs: 0 };

/** Rows from OTHER sheets whose images `sheetId` holds — GET /sheets/:id/foreign. */
function foreignFor(sheetId: string) {
  const held = new Set(SHEET_IMAGES[sheetId]?.map((slot) => `img-${slot}`));
  const regions: unknown[] = [];
  const edges: unknown[] = [];
  for (const [otherId, els] of Object.entries(elementsBySheet)) {
    if (otherId === sheetId) continue;
    const { regions: r, edges: e } = project(otherId, els);
    for (const row of r)
      if (held.has(row.imageId))
        regions.push({ ...row, sheetName: SHEET_NAME[otherId] });
    for (const row of e) {
      if (held.has(row.source.imageId) && held.has(row.target.imageId)) {
        edges.push({ ...row, sheetName: SHEET_NAME[otherId] });
      }
    }
  }
  return { regions, edges };
}

// -- making sense (CONTEXT.md): aliases, board-wide claims, reach --------
const ALIASES: Record<string, Aliases> = {};
function aliasesFor(boardId: string): Aliases {
  return ALIASES[boardId] ?? { label: {}, relation: {} };
}

/** Every sheet's projected rows on one board — the union. */
function claimsOnBoard(boardId: string) {
  const regions: ReturnType<typeof project>['regions'] = [];
  const edges: EdgeRow[] = [];
  for (const id of Object.keys(SHEET_NAME)) {
    if ((SHEET_BOARD[id] ?? 'b1') !== boardId) continue;
    const rows = project(id, elementsBySheet[id] ?? []);
    regions.push(...rows.regions);
    edges.push(...rows.edges);
  }
  return { regions, edges };
}

const repliesBySheet: Record<
  string,
  {
    id: string;
    elementId: string;
    by: { id: string; name: string };
    text: string;
    at: string;
    deleted: boolean;
  }[]
> = {};
let replySeq = 0;

/** Other sheets' edges with exactly one end on `sheetId` — GET /sheets/:id/reach. */
function reachFor(sheetId: string) {
  const held = new Set(SHEET_IMAGES[sheetId]?.map((slot) => `img-${slot}`));
  const boardId = SHEET_BOARD[sheetId] ?? 'b1';
  const edges = [];
  for (const [otherId, els] of Object.entries(elementsBySheet)) {
    if (otherId === sheetId || (SHEET_BOARD[otherId] ?? 'b1') !== boardId)
      continue;
    for (const row of project(otherId, els).edges) {
      const src = held.has(row.source.imageId);
      const dst = held.has(row.target.imageId);
      if (src === dst) continue;
      edges.push({
        ...row,
        sheetName: SHEET_NAME[otherId],
        near: src ? ('source' as const) : ('target' as const),
      });
    }
  }
  const farIds = new Set(
    edges.map((e) =>
      e.near === 'source' ? e.target.imageId : e.source.imageId,
    ),
  );
  const far = images
    .filter((img) => farIds.has(img.id))
    .map(({ id, name, width, height, missing }) => ({
      id,
      name,
      width,
      height,
      missing,
    }));
  return { edges, images: far };
}

/** GET /sheets/:id/footprint — how many OTHER sheets hold a claim this
 * sheet made (docs/phases/3-groups.md section 4's delete confirmation). */
function sheetFootprint(sheetId: string): number {
  let count = 0;
  for (const otherId of Object.keys(SHEET_NAME)) {
    if (otherId === sheetId) continue;
    const { regions, edges } = foreignFor(otherId) as {
      regions: { sheetId: string }[];
      edges: { sheetId: string }[];
    };
    const hasFromThis =
      regions.some((r) => r.sheetId === sheetId) ||
      edges.some((e) => e.sheetId === sheetId);
    if (hasFromThis) count++;
  }
  return count;
}

function boardFootprint(boardId: string) {
  const sheetIds = Object.keys(SHEET_NAME).filter(
    (id) => (SHEET_BOARD[id] ?? 'b1') === boardId,
  );
  let regions = 0;
  let edges = 0;
  for (const id of sheetIds) {
    const rows = project(id, elementsBySheet[id] ?? []);
    regions += rows.regions.length;
    edges += rows.edges.length;
  }
  return {
    images: images.filter((i) => i.boardId === boardId).length,
    sheets: sheetIds.length,
    regions,
    edges,
  };
}

function deleteSheetRows(id: string): void {
  delete SHEET_NAME[id];
  delete SHEET_IMAGES[id];
  delete elementsBySheet[id];
  delete peersBySheet[id];
  delete sheetSavedAt[id];
  delete SHEET_CREATOR[id];
  delete SHEET_BOARD[id];
}

function lastActivityForBoard(boardId: string): string | null {
  const sheetIds = Object.keys(SHEET_NAME).filter(
    (id) => (SHEET_BOARD[id] ?? 'b1') === boardId,
  );
  const times = sheetIds
    .map((id) => sheetSavedAt[id])
    .filter((t): t is string => !!t);
  return times.sort().at(-1) ?? null;
}

// -- invitations --------------------------------------------------------------
interface Invitation {
  id: string;
  groupId: string;
  email: string | null;
  inviterKey: UserKey;
  createdAt: string;
  used: boolean;
  revoked: boolean;
}
const INVITATIONS: Record<string, Invitation> = {
  // Pre-seeded, already used — the join page's "closed invitation" message
  // (docs/phases/3-groups.md section 1: one message for expired and used).
  'inv-closed': {
    id: 'inv-closed',
    groupId: 'g1',
    email: null,
    inviterKey: 'owner',
    createdAt: new Date().toISOString(),
    used: true,
    revoked: false,
  },
};
let invitationSeq = 1;
function invitationIsOpen(inv: Invitation): boolean {
  return !inv.used && !inv.revoked;
}

// -- tiles: z/x/y label plus each cell's rank, so the URL mapping is checkable by eye --
function renderTile(
  boardId: string,
  sid: string,
  z: number,
  x: number,
  y: number,
): Buffer {
  const size = 256;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#20242b';
  ctx.fillRect(0, 0, size, size);

  const sort = parseSortId(sid);
  const ranked = sort ? rankedImages(boardId, sort) : [];
  const zz = z as -5 | -4 | -3 | -2 | -1 | 0;
  const px = cellPx(zz);
  const n = Math.round(size / px);
  for (const [i, rank] of tileRanks(zz, x, y).entries()) {
    const cx = (i % n) * px;
    const cy = Math.floor(i / n) * px;
    const image = rank >= 0 ? ranked[rank] : undefined;
    ctx.fillStyle =
      image?.status === 'ready'
        ? `hsl(${(rank * 137.508) % 360}, 55%, 42%)`
        : '#333a44';
    ctx.fillRect(cx, cy, px, px);
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.strokeRect(cx + 0.5, cy + 0.5, px - 1, px - 1);
    if (px >= 20 && rank >= 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.font = `${Math.min(13, Math.floor(px * 0.28))}px monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(rank), cx + px / 2, cy + px / 2);
    }
  }
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 18px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(`${z}/${x}/${y}`, size / 2, 4);
  return canvas.toBuffer('image/png');
}

function paintImage(imageId: string): Buffer {
  const slot = Number(imageId.replace('img-', '')) || 0;
  const S = 256;
  const canvas = createCanvas(S, S);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = `hsl(${(slot * 137.508) % 360}, 65%, 55%)`;
  ctx.fillRect(0, 0, S, S);
  ctx.fillStyle = 'rgba(0,0,0,0.85)';
  ctx.font = '40px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(slot), S / 2, S / 2);
  return canvas.toBuffer('image/png');
}

const tileSeen = new Set<string>();

// cors/json/hasSession/setSessionCookie close over this one request's
// req/res rather than taking them as typed parameters — bun's bundled
// node:http typings give the listener's `res` an extra `{ req }`
// intersection member that a standalone `ServerResponse` annotation doesn't
// carry, so the two don't unify across a function boundary.
const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  function json(status: number, body: unknown) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  async function readJson<T>(): Promise<T> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    return text ? (JSON.parse(text) as T) : ({} as T);
  }

  res.setHeader('Access-Control-Allow-Origin', WEB_ORIGIN);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader(
    'Access-Control-Allow-Methods',
    // Slice 2: PUT /boards/:id/selection needs a preflight that actually
    // allows PUT — its absence here made every PUT fail the browser's own
    // preflight check silently (the OPTIONS response still came back 204,
    // so nothing server-side ever saw a rejected request to log).
    'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  );
  res.setHeader('Access-Control-Expose-Headers', 'X-Cache, Server-Timing');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (url.pathname.startsWith('/socket.io')) return;

  // -- auth (fake) -----------------------------------------------------------
  if (url.pathname === '/api/auth/get-session') {
    const u = sessionUser(req.headers.cookie);
    return u
      ? json(200, {
          session: { id: `sess-${u}`, userId: USERS[u].id },
          user: USERS[u],
        })
      : json(200, null);
  }
  if (
    url.pathname === '/api/auth/sign-in/email' ||
    url.pathname === '/api/auth/sign-up/email'
  ) {
    // The stub's per-user session: the email's local part picks one of the
    // five fixed users (falls back to `owner`, so the pre-existing smoke
    // scripts — which only ever sign in as owner@example.test — are
    // unaffected). No `?as=` query param or header needed.
    let email = '';
    try {
      email = (await readJson<{ email?: string }>()).email ?? '';
    } catch {
      // malformed body; fall through to the owner default
    }
    const local = email.split('@')[0]?.toLowerCase() ?? '';
    const key: UserKey = (USER_KEYS as string[]).includes(local)
      ? (local as UserKey)
      : 'owner';
    res.setHeader(
      'Set-Cookie',
      `${COOKIE_PREFIX}=${key}; Path=/; SameSite=Lax`,
    );
    return json(200, { user: USERS[key] });
  }
  if (url.pathname === '/api/auth/sign-out') {
    res.setHeader('Set-Cookie', `${COOKIE_PREFIX}=; Path=/; Max-Age=0`);
    return json(200, {});
  }

  // -- groups ------------------------------------------------------------------
  if (url.pathname === '/groups' && req.method === 'GET') {
    const u = sessionUser(req.headers.cookie);
    if (!u) return json(401, { reason: 'sign in required' });
    const mine = Object.values(GROUPS)
      .filter((g) => isMember(u, g.id))
      .map((g) => ({ ...g, role: roleOf(u, g.id) }));
    return json(200, mine);
  }
  if (url.pathname === '/groups' && req.method === 'POST')
    return json(201, { id: 'g1' });

  const groupInvite = url.pathname.match(/^\/groups\/([^/]+)\/invite$/);
  if (groupInvite && req.method === 'POST') {
    const u = sessionUser(req.headers.cookie);
    if (!u) return json(401, { reason: 'sign in required' });
    const groupId = groupInvite[1] ?? '';
    if (!groupOf(groupId)) return json(404, { reason: 'not found' });
    const denied = groupForInviting(u, groupId);
    if (denied) return json(403, denied);
    const body = await readJson<{ email?: string }>();
    const id = `inv-${invitationSeq++}`;
    INVITATIONS[id] = {
      id,
      groupId,
      email: body.email ?? null,
      inviterKey: u,
      createdAt: new Date().toISOString(),
      used: false,
      revoked: false,
    };
    return json(200, { invitationId: id, url: `${WEB_ORIGIN}/join/${id}` });
  }

  const groupInvitations = url.pathname.match(
    /^\/groups\/([^/]+)\/invitations$/,
  );
  if (groupInvitations && req.method === 'GET') {
    const u = sessionUser(req.headers.cookie);
    if (!u) return json(401, { reason: 'sign in required' });
    const groupId = groupInvitations[1] ?? '';
    if (!groupOf(groupId)) return json(404, { reason: 'not found' });
    const denied = groupForInviting(u, groupId);
    if (denied) return json(403, denied);
    const pending = Object.values(INVITATIONS)
      .filter((i) => i.groupId === groupId && invitationIsOpen(i))
      .map((i) => ({ id: i.id, email: i.email, createdAt: i.createdAt }));
    return json(200, pending);
  }

  // GET /invitations/:id — public, no session needed (docs/phases/3-groups.md
  // section 1). Never matches the /accept path below (that pattern needs a
  // trailing segment).
  const invitationOne = url.pathname.match(/^\/invitations\/([^/]+)$/);
  if (invitationOne && req.method === 'GET') {
    const inv = INVITATIONS[invitationOne[1] ?? ''];
    if (!inv) return json(404, { reason: 'not found' });
    return json(200, {
      groupName: groupOf(inv.groupId)?.name ?? '',
      inviterName: USERS[inv.inviterKey].name,
      open: invitationIsOpen(inv),
    });
  }
  if (invitationOne && req.method === 'DELETE') {
    const u = sessionUser(req.headers.cookie);
    if (!u) return json(401, { reason: 'sign in required' });
    const inv = INVITATIONS[invitationOne[1] ?? ''];
    if (!inv) return json(404, { reason: 'not found' });
    const denied = groupForInviting(u, inv.groupId);
    if (denied) return json(403, denied);
    inv.revoked = true;
    return json(200, {});
  }

  if (/^\/invitations\/[^/]+\/accept$/.test(url.pathname)) {
    const u = sessionUser(req.headers.cookie);
    if (!u) return json(401, { reason: 'sign in required' });
    const id = url.pathname.split('/')[2] ?? '';
    const inv = INVITATIONS[id];
    if (!inv || !invitationIsOpen(inv)) {
      return json(400, { reason: 'This invitation is no longer open.' });
    }
    inv.used = true;
    const roles = rolesOf(inv.groupId);
    if (!roles[u]) roles[u] = 'member';
    return json(200, { groupId: inv.groupId });
  }

  const groupMemberOne = url.pathname.match(
    /^\/groups\/([^/]+)\/members\/([^/]+)$/,
  );
  if (groupMemberOne && req.method === 'PATCH') {
    const u = sessionUser(req.headers.cookie);
    if (!u) return json(401, { reason: 'sign in required' });
    const groupId = groupMemberOne[1] ?? '';
    if (!groupOf(groupId)) return json(404, { reason: 'not found' });
    const targetKey = keyForUserId(groupMemberOne[2] ?? '');
    if (!targetKey || !GROUP_ROLES[groupId]?.[targetKey])
      return json(404, { reason: 'not found' });
    const denied = groupForManagingMembers(u, groupId);
    if (denied) return json(403, denied);
    const body = await readJson<{ role: GroupRole }>();
    const roles = rolesOf(groupId);
    const currentRole = roles[targetKey];
    if (
      (body.role === 'owner' || currentRole === 'owner') &&
      roles[u] !== 'owner'
    ) {
      return json(403, { reason: 'only an owner may change an owner role' });
    }
    roles[targetKey] = body.role;
    return json(200, { userId: USERS[targetKey].id, role: body.role });
  }
  if (groupMemberOne && req.method === 'DELETE') {
    const u = sessionUser(req.headers.cookie);
    if (!u) return json(401, { reason: 'sign in required' });
    const groupId = groupMemberOne[1] ?? '';
    if (!groupOf(groupId)) return json(404, { reason: 'not found' });
    const targetKey = keyForUserId(groupMemberOne[2] ?? '');
    const roles = rolesOf(groupId);
    if (!targetKey || !roles[targetKey])
      return json(404, { reason: 'not found' });
    const denied = groupForManagingMembers(u, groupId);
    if (denied) return json(403, denied);
    if (roles[targetKey] === 'owner' && roles[u] !== 'owner') {
      return json(403, { reason: 'only an owner may remove an owner' });
    }
    delete roles[targetKey];
    for (const b of BOARDS.filter((board) => board.groupId === groupId)) {
      ALLOWLIST[b.id]?.delete(targetKey);
    }
    return json(200, {});
  }

  const groupMembers = url.pathname.match(/^\/groups\/([^/]+)\/members$/);
  if (groupMembers && req.method === 'GET') {
    const u = sessionUser(req.headers.cookie);
    if (!u) return json(401, { reason: 'sign in required' });
    const groupId = groupMembers[1] ?? '';
    if (!groupOf(groupId)) return json(404, { reason: 'not found' });
    const denied = groupForViewing(u, groupId);
    if (denied) return json(403, denied);
    return json(200, currentMembers(groupId));
  }
  const groupLeave = url.pathname.match(/^\/groups\/([^/]+)\/leave$/);
  if (groupLeave) {
    const u = sessionUser(req.headers.cookie);
    if (!u) return json(401, { reason: 'sign in required' });
    const groupId = groupLeave[1] ?? '';
    if (!groupOf(groupId)) return json(404, { reason: 'not found' });
    if (!isMember(u, groupId)) return json(403, { reason: 'not a member' });
    const roles = rolesOf(groupId);
    if (roles[u] === 'owner') {
      const owners = USER_KEYS.filter((k) => roles[k] === 'owner');
      if (owners.length <= 1) {
        return json(400, { reason: 'the sole owner cannot leave the group' });
      }
    }
    delete roles[u];
    for (const b of BOARDS.filter((board) => board.groupId === groupId)) {
      ALLOWLIST[b.id]?.delete(u);
    }
    return json(200, {});
  }

  const groupSheetsRecent = url.pathname.match(
    /^\/groups\/([^/]+)\/sheets\/recent$/,
  );
  if (groupSheetsRecent && req.method === 'GET') {
    const u = sessionUser(req.headers.cookie);
    if (!u) return json(401, { reason: 'sign in required' });
    const groupId = groupSheetsRecent[1] ?? '';
    if (!groupOf(groupId)) return json(404, { reason: 'not found' });
    const denied = groupForViewing(u, groupId);
    if (denied) return json(403, denied);
    const visible = new Set(
      BOARDS.filter(
        (b) => b.groupId === groupId && !boardForViewing(u, b.id),
      ).map((b) => b.id),
    );
    const list = Object.keys(SHEET_NAME)
      .filter((id) => visible.has(SHEET_BOARD[id] ?? 'b1'))
      .map((id) => ({
        id,
        name: SHEET_NAME[id],
        boardId: SHEET_BOARD[id] ?? 'b1',
        boardName: boardOf(SHEET_BOARD[id] ?? 'b1')?.name ?? '',
        savedAt: sheetSavedAt[id] ?? null,
      }))
      .sort((a, b) => (b.savedAt ?? '').localeCompare(a.savedAt ?? ''))
      .slice(0, 10);
    return json(200, list);
  }

  // -- boards --------------------------------------------------------------------
  const boardsList = url.pathname.match(/^\/groups\/([^/]+)\/boards$/);
  if (boardsList && req.method === 'GET') {
    const u = sessionUser(req.headers.cookie);
    if (!u) return json(401, { reason: 'sign in required' });
    const groupId = boardsList[1] ?? '';
    if (!groupOf(groupId)) return json(404, { reason: 'not found' });
    const denied = groupForViewing(u, groupId);
    if (denied) return json(403, denied);
    const visible = BOARDS.filter(
      (b) => b.groupId === groupId && !boardForViewing(u, b.id),
    );
    return json(
      200,
      visible.map((b) => ({
        id: b.id,
        name: b.name,
        open: b.open,
        imageCount: b.imageCount,
        groupId: b.groupId,
        sheetCount: Object.keys(SHEET_NAME).filter(
          (id) => (SHEET_BOARD[id] ?? 'b1') === b.id,
        ).length,
        lastActivity: lastActivityForBoard(b.id),
      })),
    );
  }
  if (boardsList && req.method === 'POST') {
    const u = sessionUser(req.headers.cookie);
    if (!u) return json(401, { reason: 'sign in required' });
    const groupId = boardsList[1] ?? '';
    if (!groupOf(groupId)) return json(404, { reason: 'not found' });
    const denied = groupForViewing(u, groupId); // boardForCreating: any group member
    if (denied) return json(403, denied);
    const body = await readJson<{ name: string; open: boolean }>();
    const id = `b${boardSeq++}`;
    BOARDS.push({
      id,
      name: body.name,
      open: body.open,
      imageCount: 0,
      createdBy: u,
      defaultSort: 'uploaded_at.desc',
      groupId,
    });
    if (!body.open) ALLOWLIST[id] = new Set([u]);
    return json(201, { id });
  }

  const boardOne = url.pathname.match(/^\/boards\/([^/]+)$/);
  if (boardOne && req.method === 'GET') {
    const u = sessionUser(req.headers.cookie);
    if (!u) return json(401, { reason: 'sign in required' });
    const denied = boardForViewing(u, boardOne[1] ?? '');
    if (denied) return json(403, denied);
    const board = boardOf(boardOne[1] ?? '');
    if (!board) return json(404, { reason: 'not found' });
    return json(200, {
      id: board.id,
      name: board.name,
      open: board.open,
      imageCount: board.imageCount,
      defaultSort: board.defaultSort,
      sortableKeys: SORTABLE_KEYS,
      groupId: board.groupId,
    });
  }
  if (boardOne && req.method === 'PATCH') {
    const u = sessionUser(req.headers.cookie);
    if (!u) return json(401, { reason: 'sign in required' });
    const board = boardOf(boardOne[1] ?? '');
    if (!board) return json(404, { reason: 'not found' });
    const denied = boardForRenaming(u, board.id);
    if (denied) return json(403, denied);
    const body = await readJson<{ name?: string; defaultSort?: string }>();
    if (body.name !== undefined) {
      board.name = body.name;
      return json(200, { name: board.name });
    }
    if (body.defaultSort !== undefined) {
      board.defaultSort = body.defaultSort;
      return json(200, { defaultSort: board.defaultSort });
    }
    return json(400, { reason: 'nothing to update' });
  }
  if (boardOne && req.method === 'DELETE') {
    const u = sessionUser(req.headers.cookie);
    if (!u) return json(401, { reason: 'sign in required' });
    const board = boardOf(boardOne[1] ?? '');
    if (!board) return json(404, { reason: 'not found' });
    const denied = boardForDeleting(u, board.id);
    if (denied) return json(403, denied);
    images = images.filter((i) => i.boardId !== board.id);
    for (const id of Object.keys(SHEET_NAME)) {
      if ((SHEET_BOARD[id] ?? 'b1') === board.id) deleteSheetRows(id);
    }
    delete ALLOWLIST[board.id];
    for (const key of Object.keys(SELECTIONS)) {
      if (key.startsWith(`${board.id}:`)) delete SELECTIONS[key];
    }
    const idx = BOARDS.findIndex((b) => b.id === board.id);
    if (idx >= 0) BOARDS.splice(idx, 1);
    return json(200, {});
  }

  const boardFootprintMatch = url.pathname.match(
    /^\/boards\/([^/]+)\/footprint$/,
  );
  if (boardFootprintMatch && req.method === 'GET') {
    const u = sessionUser(req.headers.cookie);
    if (!u) return json(401, { reason: 'sign in required' });
    const boardId = boardFootprintMatch[1] ?? '';
    const denied = boardForDeleting(u, boardId);
    if (denied) return json(403, denied);
    if (!boardOf(boardId)) return json(404, { reason: 'not found' });
    return json(200, boardFootprint(boardId));
  }

  const boardAllowlist = url.pathname.match(/^\/boards\/([^/]+)\/allowlist$/);
  if (boardAllowlist && req.method === 'GET') {
    const u = sessionUser(req.headers.cookie);
    if (!u) return json(401, { reason: 'sign in required' });
    const boardId = boardAllowlist[1] ?? '';
    const denied = boardForViewing(u, boardId);
    if (denied) return json(403, denied);
    const set = ALLOWLIST[boardId] ?? new Set<UserKey>();
    const board = boardOf(boardId);
    return json(200, {
      groupId: board?.groupId ?? '',
      members: Array.from(set).map((k) => ({
        userId: USERS[k].id,
        email: USERS[k].email,
        name: USERS[k].name,
        role: (board && roleOf(k, board.groupId)) ?? 'member',
      })),
    });
  }
  if (boardAllowlist && req.method === 'POST') {
    const u = sessionUser(req.headers.cookie);
    if (!u) return json(401, { reason: 'sign in required' });
    const boardId = boardAllowlist[1] ?? '';
    const denied = boardForManagingAllowlist(u, boardId);
    if (denied) return json(403, denied);
    const body = await readJson<{ userId: string }>();
    const targetKey = keyForUserId(body.userId);
    const board = boardOf(boardId);
    if (!targetKey || !board || !roleOf(targetKey, board.groupId)) {
      return json(400, { reason: 'user is not a member of the group' });
    }
    if (!ALLOWLIST[boardId]) ALLOWLIST[boardId] = new Set();
    ALLOWLIST[boardId]?.add(targetKey);
    return json(
      200,
      Array.from(ALLOWLIST[boardId] ?? []).map((k) => ({
        userId: USERS[k].id,
      })),
    );
  }

  const boardAllowlistUser = url.pathname.match(
    /^\/boards\/([^/]+)\/allowlist\/([^/]+)$/,
  );
  if (boardAllowlistUser && req.method === 'DELETE') {
    const u = sessionUser(req.headers.cookie);
    if (!u) return json(401, { reason: 'sign in required' });
    const boardId = boardAllowlistUser[1] ?? '';
    const denied = boardForManagingAllowlist(u, boardId);
    if (denied) return json(403, denied);
    const targetKey = keyForUserId(boardAllowlistUser[2] ?? '');
    if (!targetKey) return json(404, { reason: 'not found' });
    const board = boardOf(boardId);
    if (targetKey === board?.createdBy) {
      const others = Array.from(ALLOWLIST[boardId] ?? []).filter(
        (k) => k !== targetKey,
      );
      const hasManager = others.some((k) => {
        const role = board && roleOf(k, board.groupId);
        return role === 'owner' || role === 'admin';
      });
      if (!hasManager) {
        return json(400, {
          reason: 'the board would have no manager left on its allowlist',
        });
      }
    }
    ALLOWLIST[boardId]?.delete(targetKey);
    return json(
      200,
      Array.from(ALLOWLIST[boardId] ?? []).map((k) => ({
        userId: USERS[k].id,
      })),
    );
  }

  const uploadStatuses = url.pathname.match(
    /^\/boards\/([^/]+)\/images\/status$/,
  );
  if (uploadStatuses && req.method === 'POST') {
    const user = sessionUser(req.headers.cookie);
    if (!user) return json(401, { reason: 'sign in required' });
    const boardId = uploadStatuses[1] ?? '';
    const denied = boardForViewing(user, boardId);
    if (denied) return json(403, denied);
    const body = await readJson<{ ids?: unknown } | null>();
    if (
      !Array.isArray(body?.ids) ||
      body.ids.length > 500 ||
      !body.ids.every((id) => typeof id === 'string')
    ) {
      return json(400, { reason: 'ids must contain at most 500 image IDs' });
    }
    const byId = new Map(
      images
        .filter((image) => image.boardId === boardId)
        .map((image) => [image.id, image]),
    );
    return json(200, {
      images: body.ids.flatMap((id) => {
        const image = byId.get(id);
        return image
          ? [{ id, status: image.status, error: image.error ?? null }]
          : [];
      }),
    });
  }

  const boardImages = url.pathname.match(/^\/boards\/([^/]+)\/images$/);
  if (boardImages && req.method === 'GET') {
    const u = sessionUser(req.headers.cookie);
    if (!u) return json(401, { reason: 'sign in required' });
    const boardId = boardImages[1] ?? '';
    const denied = boardForViewing(u, boardId);
    if (denied) return json(403, denied);
    const sort = parseSortId(url.searchParams.get('sort') ?? '') ?? {
      key: 'uploaded_at' as const,
      dir: 'desc' as const,
    };
    // Phase 2 section 4 (docs/phases/2-sheet.md): `ids` — not a param the
    // real server has yet (web/src/lib/api.ts's header comment on
    // `getBoardImagesByIds`) — answers with exactly those images, in the
    // order given, each carrying its RANK under `sort` so Board.tsx's
    // `selectImages(ids)` can highlight the map with one call. Ignores
    // from/count; a rank lookup by id has no notion of a page.
    const idsParam = url.searchParams.get('ids');
    if (idsParam) {
      const wanted = idsParam.split(',').filter(Boolean);
      const rankByImageId = new Map(
        rankedImages(boardId, sort).map((img, i) => [img.id, i]),
      );
      const found = wanted
        .map((id) => images.find((i) => i.id === id && i.boardId === boardId))
        .filter((i): i is Img => !!i)
        .map((img) => ({ ...img, rank: rankByImageId.get(img.id) }));
      return json(200, { images: found });
    }
    const from = Number(url.searchParams.get('from') ?? '0');
    const count = Number(url.searchParams.get('count') ?? '50');
    return json(200, {
      images: rankedImages(boardId, sort).slice(from, from + count),
    });
  }
  if (boardImages && req.method === 'POST') {
    const u = sessionUser(req.headers.cookie);
    if (!u) return json(401, { reason: 'sign in required' });
    const boardId = boardImages[1] ?? '';
    const denied = boardForViewing(u, boardId); // boardForUploading: same rule
    if (denied) return json(403, denied);
    // dev stub: read the original filenames out of the multipart body so
    // web/'s poll-by-name fallback (for a tus upload, whose success payload
    // carries no image id) has something real to match against.
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString('latin1');
    const filenames = [
      ...body.matchAll(/name="files"; filename="([^"]*)"/g),
    ].map((m) => m[1] ?? '');
    const added = Math.max(1, filenames.length);
    const boardImageCount = images.filter((i) => i.boardId === boardId).length;
    const created: Img[] = range(boardImageCount, boardImageCount + added).map(
      (slot, i) => ({
        ...makeImg(boardId, slot),
        name: filenames[i] || `image-${slot}`,
        status: 'pending',
      }),
    );
    images = [...images, ...created];
    const board = boardOf(boardId);
    if (board) board.imageCount = boardImageCount + added;
    // the worker: paint the ladder, then flip pending -> ready
    for (const img of created) {
      setTimeout(() => {
        img.status = 'ready';
      }, READY_DELAY_MS);
    }
    // the real multipart route waits (up to 10s) for its own uploads to
    // leave pending before responding, `?wait=0` to skip it — mirrored here
    // so web/'s "batch already came back ready" fast path gets exercised.
    if (url.searchParams.get('wait') !== '0') {
      const deadline = Date.now() + READY_DELAY_MS + 500;
      while (
        Date.now() < deadline &&
        created.some((i) => i.status === 'pending')
      ) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    return json(
      202,
      created.map((i) => ({ id: i.id, slot: i.slot, status: i.status })),
    );
  }

  // GET/PUT /boards/:id/selection — docs/ux/design.md §7 slice 2. A viewer's
  // selection is ids, not ranks, so it survives a sort change untouched.
  const boardSelection = url.pathname.match(/^\/boards\/([^/]+)\/selection$/);
  if (boardSelection && req.method === 'GET') {
    const u = sessionUser(req.headers.cookie);
    if (!u) return json(401, { reason: 'sign in required' });
    const boardId = boardSelection[1] ?? '';
    const denied = boardForViewing(u, boardId);
    if (denied) return json(403, denied);
    if (!boardOf(boardId)) return json(404, { reason: 'not found' });
    const imageIds = SELECTIONS[selectionKey(boardId, USERS[u].id)] ?? [];
    return json(200, { imageIds });
  }
  if (boardSelection && req.method === 'PUT') {
    const u = sessionUser(req.headers.cookie);
    if (!u) return json(401, { reason: 'sign in required' });
    const boardId = boardSelection[1] ?? '';
    const denied = boardForViewing(u, boardId);
    if (denied) return json(403, denied);
    if (!boardOf(boardId)) return json(404, { reason: 'not found' });
    const body = await readJson<{ imageIds: string[] }>();
    // Drop anything that isn't (or is no longer) an image on this board —
    // never trust the client to have an honest set.
    const boardImageIds = new Set(
      images.filter((i) => i.boardId === boardId).map((i) => i.id),
    );
    const imageIds = (body.imageIds ?? []).filter((id) =>
      boardImageIds.has(id),
    );
    SELECTIONS[selectionKey(boardId, USERS[u].id)] = imageIds;
    return json(200, { imageIds });
  }

  // POST /boards/:id/selection/range {sort, fromRank, toRank} — resolves a
  // rank range to ids SERVER-SIDE (design.md §5.1), capped, so a band/
  // shift-click select over a huge board never pages ranks to the client.
  const selectionRange = url.pathname.match(
    /^\/boards\/([^/]+)\/selection\/range$/,
  );
  if (selectionRange && req.method === 'POST') {
    const u = sessionUser(req.headers.cookie);
    if (!u) return json(401, { reason: 'sign in required' });
    const boardId = selectionRange[1] ?? '';
    const denied = boardForViewing(u, boardId);
    if (denied) return json(403, denied);
    const body = await readJson<{
      sort: string;
      fromRank: number;
      toRank: number;
      mode?: 'band';
    }>();
    if (
      !Number.isSafeInteger(body.fromRank) ||
      !Number.isSafeInteger(body.toRank) ||
      body.fromRank < 0 ||
      body.toRank < 0 ||
      body.fromRank > 2_147_483_647 ||
      body.toRank > 2_147_483_647 ||
      (body.mode !== undefined && body.mode !== 'band')
    ) {
      return json(400, { reason: 'invalid selection range' });
    }
    const sort = parseSortId(body.sort) ?? {
      key: 'uploaded_at' as const,
      dir: 'desc' as const,
    };
    const ranked = rankedImages(boardId, sort);
    const lo = Math.max(0, Math.min(body.fromRank, body.toRank));
    const hi = Math.min(
      ranked.length - 1,
      Math.max(body.fromRank, body.toRank),
    );
    const loCol = Math.min(body.fromRank % COLS, body.toRank % COLS);
    const hiCol = Math.max(body.fromRank % COLS, body.toRank % COLS);
    const imageIds: string[] = [];
    const cap = body.mode === 'band' ? SHEET_LIMIT : SELECTION_RANGE_CAP;
    for (let r = lo; r <= hi && imageIds.length < cap; r++) {
      if (body.mode === 'band' && (r % COLS < loCol || r % COLS > hiCol)) {
        continue;
      }
      const img = ranked[r];
      if (img) imageIds.push(img.id);
    }
    return json(200, { imageIds });
  }

  // POST /boards/:id/sheets/:sheetId/images {imageIds} — "Add to sheet…"
  // (design.md §5.1's "What a selection can become"): skips ids already on
  // the sheet, places the rest to the right of its existing content.
  const sheetAddImages = url.pathname.match(
    /^\/boards\/([^/]+)\/sheets\/([^/]+)\/images$/,
  );
  if (sheetAddImages && req.method === 'POST') {
    const u = sessionUser(req.headers.cookie);
    if (!u) return json(401, { reason: 'sign in required' });
    const boardId = sheetAddImages[1] ?? '';
    const sheetId = sheetAddImages[2] ?? '';
    const denied = boardForViewing(u, boardId); // boardForCreatingSheet: same rule
    if (denied) return json(403, denied);
    if (!SHEET_NAME[sheetId] || (SHEET_BOARD[sheetId] ?? 'b1') !== boardId) {
      return json(404, { reason: 'not found' });
    }
    const body = await readJson<{ imageIds: string[] }>();
    const existing = elementsBySheet[sheetId] ?? [];
    const existingImageIds = new Set(
      existing
        .filter((e) => (e.customData as { kind?: string })?.kind === 'image')
        .map((e) => (e.customData as { imageId?: string })?.imageId)
        .filter((x): x is string => !!x),
    );
    const seen = new Set<string>();
    const wanted = (body.imageIds ?? []).filter((id) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    const room = Math.max(0, SHEET_LIMIT - existingImageIds.size);
    const toAdd = wanted
      .filter((id) => !existingImageIds.has(id))
      .slice(0, room);
    const skipped = wanted.filter(
      (id) => existingImageIds.has(id) || !toAdd.includes(id),
    );
    const ordered = toAdd
      .map((imgId) =>
        images.find((i) => i.id === imgId && i.boardId === boardId),
      )
      .filter((i): i is Img => !!i);

    // "placed to the right of existing content": lay the new images out in
    // a row starting past the current rightmost edge.
    let rightEdge = 0;
    for (const e of existing) {
      const ex = (e as { x?: number }).x ?? 0;
      const ew = (e as { width?: number }).width ?? 0;
      rightEdge = Math.max(rightEdge, ex + ew);
    }
    let cursorX = rightEdge + SHEET_CELL / 2;
    const newEls = ordered.map((img) => {
      const scale = fitScale(img.width, img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      const x = cursorX;
      const y = 0;
      cursorX += SHEET_CELL;
      return el({
        id: `el-img-${img.id}`,
        type: 'image',
        x,
        y,
        width: w,
        height: h,
        fileId: fileId(img.id),
        customData: { kind: 'image', imageId: img.id },
        groupIds: [imageGroupId(img.id)],
      });
    });
    elementsBySheet[sheetId] = [...existing, ...newEls];
    SHEET_IMAGES[sheetId] = [
      ...(SHEET_IMAGES[sheetId] ?? []),
      ...ordered.map((i) => i.slot),
    ];
    sheetSavedAt[sheetId] = new Date().toISOString();
    // server/src/sheets/routes.ts: the room sees the merged scene at once,
    // so a peer with the sheet open gets the new images live.
    io.to(sheetId).emit('scene', {
      elements: elementsBySheet[sheetId],
      from: 'server',
    });
    return json(200, { added: ordered.map((i) => i.id), skipped });
  }

  // GET /groups/:id/sheets — every sheet of every board the viewer can see
  // in the group, one request (slice 2 follow-up b: replaces the shell's
  // per-board `listSheets` loop).
  const groupSheets = url.pathname.match(/^\/groups\/([^/]+)\/sheets$/);
  if (groupSheets && req.method === 'GET') {
    const u = sessionUser(req.headers.cookie);
    if (!u) return json(401, { reason: 'sign in required' });
    const groupId = groupSheets[1] ?? '';
    if (!groupOf(groupId)) return json(404, { reason: 'not found' });
    const denied = groupForViewing(u, groupId);
    if (denied) return json(403, denied);
    const visibleBoardIds = new Set(
      BOARDS.filter(
        (b) => b.groupId === groupId && !boardForViewing(u, b.id),
      ).map((b) => b.id),
    );
    const list = Object.keys(SHEET_NAME)
      .filter((id) => visibleBoardIds.has(SHEET_BOARD[id] ?? 'b1'))
      .filter(
        (id) =>
          url.searchParams.get('archived') === '1' || !SHEET_ARCHIVED.has(id),
      )
      .map((id) => ({
        id,
        name: SHEET_NAME[id],
        createdAt: new Date().toISOString(),
        imageCount: (SHEET_IMAGES[id] ?? []).length,
        savedAt: sheetSavedAt[id] ?? null,
        boardId: SHEET_BOARD[id] ?? 'b1',
        boardName: boardOf(SHEET_BOARD[id] ?? 'b1')?.name ?? '',
        archived: SHEET_ARCHIVED.has(id),
        lastActivityAt: sheetSavedAt[id] ?? SHEET_CREATED_AT,
        unread:
          (SHEET_READS.get(`${u}:${id}`) ?? '') <
          (sheetSavedAt[id] ?? SHEET_CREATED_AT),
        previewImageIds: (SHEET_IMAGES[id] ?? [])
          .slice(0, 4)
          .map(
            (slot) =>
              images.find(
                (image) =>
                  image.boardId === (SHEET_BOARD[id] ?? 'b1') &&
                  image.slot === slot,
              )?.id,
          )
          .filter((id): id is string => !!id),
      }))
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
    return json(200, list);
  }

  // GET /boards/:id/search?text= and /similar?image= — search by meaning.
  // The stub has no embeddings, so "meaning" is a stand-in that is stable
  // and testable: similar is nearness in upload order, search is a hash of
  // text and id. Best first, like the real server; scores close together.
  const meaning = url.pathname.match(
    /^\/boards\/([^/]+)\/(search|similar|duplicates)$/,
  );
  if (meaning && req.method === 'GET') {
    const u = sessionUser(req.headers.cookie);
    if (!u) return json(401, { reason: 'sign in required' });
    const boardId = meaning[1] ?? '';
    const denied = boardForViewing(u, boardId);
    if (denied) return json(403, denied);
    if (!boardOf(boardId)) return json(404, { reason: 'not found' });
    const sort = parseSortId(url.searchParams.get('sort') ?? '') ?? {
      key: 'uploaded_at' as const,
      dir: 'desc' as const,
    };
    const ranked = rankedImages(boardId, sort);
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 200), 500);
    let scored: { img: Img; score: number }[];
    if (meaning[2] === 'duplicates') {
      // Stand-in: the picture uploaded right after this one is its copy.
      const source = ranked.find(
        (img) => img.id === url.searchParams.get('image'),
      );
      if (!source) return json(400, { error: 'image is not on this board' });
      const copy = ranked.find((img) => img.slot === source.slot + 1);
      return json(200, {
        matches: copy
          ? [{ imageId: copy.id, rank: ranked.indexOf(copy), score: 0.99 }]
          : [],
      });
    }
    if (meaning[2] === 'similar') {
      const source = ranked.find(
        (img) => img.id === url.searchParams.get('image'),
      );
      if (!source) return json(400, { error: 'image is not on this board' });
      scored = ranked
        .filter((img) => img.id !== source.id)
        .map((img) => ({
          img,
          score: 0.31 - Math.abs(img.slot - source.slot) * 0.001,
        }));
    } else {
      const text = (url.searchParams.get('text') ?? '').trim();
      const hash = (key: string) => {
        let h = 0;
        for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
        return (h % 1000) / 1000;
      };
      scored = ranked.map((img) => ({
        img,
        score: 0.23 + 0.08 * hash(`${text}|${img.id}`),
      }));
    }
    scored.sort((a, b) => b.score - a.score);
    return json(200, {
      matches: scored.slice(0, limit).map(({ img, score }) => ({
        imageId: img.id,
        rank: ranked.indexOf(img),
        score,
      })),
    });
  }

  // GET /boards/:id/find?sort=&q=&filter= — bounded rank highlights plus
  // the first SHEET_LIMIT image ids for selection, and the uncapped count.
  const boardFind = url.pathname.match(/^\/boards\/([^/]+)\/find$/);
  if (boardFind && req.method === 'GET') {
    const u = sessionUser(req.headers.cookie);
    if (!u) return json(401, { reason: 'sign in required' });
    const boardId = boardFind[1] ?? '';
    const denied = boardForViewing(u, boardId);
    if (denied) return json(403, denied);
    if (!boardOf(boardId)) return json(404, { reason: 'not found' });
    const sort = parseSortId(url.searchParams.get('sort') ?? '') ?? {
      key: 'uploaded_at' as const,
      dir: 'desc' as const,
    };
    const query = (url.searchParams.get('q') ?? '').trim().toLocaleLowerCase();
    let filters: FindFilterClause[] = [];
    try {
      const raw = url.searchParams.get('filter');
      if (raw) filters = JSON.parse(raw) as FindFilterClause[];
      if (!Array.isArray(filters)) throw new Error('filter must be an array');
    } catch {
      return json(400, { reason: 'invalid filter' });
    }
    const matchesFilter = (img: Img, clause: FindFilterClause): boolean => {
      const actual = (img.properties as Record<string, unknown>)[clause.key];
      const expected = clause.value;
      switch (clause.op) {
        case 'eq':
          return actual === expected;
        case 'neq':
          return actual !== expected;
        case 'lt':
          return typeof actual === 'number' && actual < Number(expected);
        case 'lte':
          return typeof actual === 'number' && actual <= Number(expected);
        case 'gt':
          return typeof actual === 'number' && actual > Number(expected);
        case 'gte':
          return typeof actual === 'number' && actual >= Number(expected);
        case 'between':
          return (
            Array.isArray(expected) &&
            typeof actual === 'number' &&
            actual >= Number(expected[0]) &&
            actual <= Number(expected[1])
          );
        case 'in':
          return Array.isArray(expected) && expected.includes(actual);
        case 'has':
          return Array.isArray(actual) && actual.includes(expected);
      }
    };
    // Claim filters (CONTEXT.md "Making sense"), matched through aliases.
    const claims = claimsOnBoard(boardId);
    const aliases = aliasesFor(boardId);
    const label = url.searchParams.get('label');
    const relation = url.searchParams.get('relation');
    const labelled = label
      ? new Set(
          claims.regions
            .filter((r) => termsMeaning(label, aliases.label).includes(r.label))
            .map((r) => r.imageId),
        )
      : null;
    const related = relation
      ? new Set(
          claims.edges
            .filter((e) =>
              termsMeaning(relation, aliases.relation).includes(e.relation),
            )
            .flatMap((e) => [e.source.imageId, e.target.imageId]),
        )
      : null;
    const annotated =
      url.searchParams.get('annotated') === '1'
        ? new Set([
            ...claims.regions.map((r) => r.imageId),
            ...claims.edges.flatMap((e) => [
              e.source.imageId,
              e.target.imageId,
            ]),
          ])
        : null;
    const matched = rankedImages(boardId, sort).filter((img) => {
      const haystack = [img.name, ...Object.values(img.properties).map(String)]
        .join(' ')
        .toLocaleLowerCase();
      return (
        (!query || haystack.includes(query)) &&
        filters.every((f) => matchesFilter(img, f)) &&
        (!labelled || labelled.has(img.id)) &&
        (!related || related.has(img.id)) &&
        (!annotated || annotated.has(img.id))
      );
    });
    return json(200, {
      ranks: matched
        .slice(0, 10_000)
        .map((img) =>
          rankedImages(boardId, sort).findIndex(
            (ranked) => ranked.id === img.id,
          ),
        ),
      imageIds: matched.slice(0, SHEET_LIMIT).map((img) => img.id),
      count: matched.length,
    });
  }

  const boardSections = url.pathname.match(/^\/boards\/([^/]+)\/sections$/);
  if (boardSections && req.method === 'GET') {
    const u = sessionUser(req.headers.cookie);
    if (!u) return json(401, { reason: 'sign in required' });
    const boardId = boardSections[1] ?? '';
    const denied = boardForViewing(u, boardId);
    if (denied) return json(403, denied);
    const sort = parseSortId(url.searchParams.get('sort') ?? '') ?? {
      key: 'uploaded_at' as const,
      dir: 'desc' as const,
    };
    return json(200, computeSections(boardId, sort));
  }

  // GET /boards/:id/vocabulary (server/src/boards/vocabulary.ts): every
  // label and relation on the board's sheets, folded onto aliases.
  const boardVocabulary = url.pathname.match(/^\/boards\/([^/]+)\/vocabulary$/);
  if (boardVocabulary && req.method === 'GET') {
    const u = sessionUser(req.headers.cookie);
    if (!u) return json(401, { reason: 'sign in required' });
    const boardId = boardVocabulary[1] ?? '';
    const denied = boardForViewing(u, boardId);
    if (denied) return json(403, denied);
    const claims = claimsOnBoard(boardId);
    const aliases = aliasesFor(boardId);
    const count = (terms: string[]) => {
      const counts = new Map<string, number>();
      for (const t of terms) counts.set(t, (counts.get(t) ?? 0) + 1);
      return counts;
    };
    return json(200, {
      labels: buildVocabulary(
        count(claims.regions.map((r) => r.label)),
        aliases.label,
      ),
      relations: buildVocabulary(
        count(claims.edges.map((e) => e.relation)),
        aliases.relation,
      ),
      aliases,
    });
  }

  // PUT /boards/:id/aliases, DELETE /boards/:id/aliases/:kind/:term.
  const boardAliases = url.pathname.match(
    /^\/boards\/([^/]+)\/aliases(?:\/(label|relation)\/([^/]+))?$/,
  );
  if (boardAliases && (req.method === 'PUT' || req.method === 'DELETE')) {
    const u = sessionUser(req.headers.cookie);
    if (!u) return json(401, { reason: 'sign in required' });
    const boardId = boardAliases[1] ?? '';
    const denied = boardForViewing(u, boardId);
    if (denied) return json(403, denied);
    const current = aliasesFor(boardId);
    if (req.method === 'DELETE') {
      const kind = boardAliases[2] as TermKind | undefined;
      const term = decodeURIComponent(boardAliases[3] ?? '');
      if (!kind) return json(400, { error: 'kind must be label or relation' });
      const next = { ...current[kind] };
      delete next[term];
      ALIASES[boardId] = { ...current, [kind]: next };
      return json(200, ALIASES[boardId]);
    }
    const body = await readJson<{
      kind?: TermKind;
      term?: string;
      canonical?: string;
    }>();
    const kind = body.kind;
    const term = body.term?.trim() ?? '';
    const canonical = body.canonical?.trim() ?? '';
    if (kind !== 'label' && kind !== 'relation')
      return json(400, { error: 'kind must be label or relation' });
    if (!term || !canonical)
      return json(400, { error: 'term and canonical are required' });
    const next = withAlias(current[kind], term, canonical);
    if (!next) return json(400, { error: 'a term cannot mean itself' });
    ALIASES[boardId] = { ...current, [kind]: next };
    return json(200, ALIASES[boardId]);
  }

  // GET /boards/:id/neighbourhood?from=&hops=&relation= (docs/phases/2-sheet.md
  // section 4) — mirrors server/src/sheets/neighbourhood.ts's contract:
  // breadth-first over the board's WHOLE graph (every sheet's edges
  // unioned, CONTEXT.md "The union"), nearest-first, capped at SHEET_LIMIT.
  const boardNeighbourhood = url.pathname.match(
    /^\/boards\/([^/]+)\/neighbourhood$/,
  );
  if (boardNeighbourhood && req.method === 'GET') {
    const u = sessionUser(req.headers.cookie);
    if (!u) return json(401, { reason: 'sign in required' });
    const boardId = boardNeighbourhood[1] ?? '';
    const denied = boardForViewing(u, boardId);
    if (denied) return json(403, denied);
    const from = url.searchParams.get('from');
    if (!from) return json(400, { error: 'from required' });
    const hops = Number(url.searchParams.get('hops'));
    if (!Number.isInteger(hops) || hops < 1 || hops > 3) {
      return json(400, { error: 'hops must be an integer 1..3' });
    }
    const relation = url.searchParams.get('relation') || undefined;
    const fromImg = images.find((i) => i.id === from && i.boardId === boardId);
    if (!fromImg) {
      return json(400, { error: 'from is not an image on this board' });
    }

    const sheetIds = Object.keys(SHEET_NAME).filter(
      (id) => (SHEET_BOARD[id] ?? 'b1') === boardId,
    );
    const allEdges: EdgeRow[] = [];
    for (const id of sheetIds) {
      allEdges.push(...project(id, elementsBySheet[id] ?? []).edges);
    }
    const meaning = relation
      ? new Set(termsMeaning(relation, aliasesFor(boardId).relation))
      : null;
    const relevant = meaning
      ? allEdges.filter((e) => meaning.has(e.relation))
      : allEdges;
    const adj = new Map<string, Set<string>>();
    function link(a: string, b: string) {
      if (!adj.has(a)) adj.set(a, new Set());
      adj.get(a)?.add(b);
    }
    for (const e of relevant) {
      link(e.source.imageId, e.target.imageId);
      link(e.target.imageId, e.source.imageId);
    }

    const distances = new Map<string, number>([[from, 0]]);
    const queue = [from];
    while (queue.length) {
      const cur = queue.shift();
      if (!cur) continue;
      const d = distances.get(cur) ?? 0;
      if (d >= hops) continue;
      for (const next of adj.get(cur) ?? []) {
        if (!distances.has(next)) {
          distances.set(next, d + 1);
          queue.push(next);
        }
      }
    }

    const ordered = Array.from(distances.entries())
      .sort((a, b) => a[1] - b[1])
      .map(([id, hopsAway]) => ({ id, hops: hopsAway }));
    const truncated = ordered.length > SHEET_LIMIT;
    const imagesOut = ordered.slice(0, SHEET_LIMIT);
    const idSet = new Set(imagesOut.map((i) => i.id));
    const edgesOut = relevant.filter(
      (e) => idSet.has(e.source.imageId) && idSet.has(e.target.imageId),
    );
    return json(200, { images: imagesOut, edges: edgesOut, truncated });
  }

  const tileMatch = url.pathname.match(
    /^\/boards\/([^/]+)\/tiles\/([^/]+)\/(-?\d+)\/(-?\d+)\/(-?\d+)\.png$/,
  );
  if (tileMatch) {
    const u = sessionUser(req.headers.cookie);
    if (!u) return json(401, { reason: 'sign in required' });
    const boardId = tileMatch[1] ?? '';
    const denied = boardForViewing(u, boardId);
    if (denied) return json(403, denied);
    const [, , sid, zs, xs, ys] = tileMatch;
    const key = `${boardId}/${sid}/${zs}/${xs}/${ys}`;
    const hit = tileSeen.has(key);
    tileSeen.add(key);
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'X-Cache': hit ? 'hit' : 'miss',
      'Server-Timing': `rank;dur=0.5, compose;dur=${hit ? 0 : 5}`,
      'Cache-Control': 'private, max-age=60',
    });
    res.end(renderTile(boardId, sid ?? '', Number(zs), Number(xs), Number(ys)));
    return;
  }

  const imageOriginal = url.pathname.match(/^\/images\/([^/]+)\/original$/);
  if (imageOriginal) {
    const img = images.find((i) => i.id === imageOriginal[1]);
    // Missing mirrors the real server: the original file is removed on
    // delete, the row stays (docs/phases/3-groups.md section 4).
    if (!img || img.missing) return json(404, { reason: 'missing' });
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(paintImage(imageOriginal[1] ?? ''));
    return;
  }
  // GET /images/:id/preview (docs/phases/2-sheet.md section 7): the sheet
  // canvas loads this instead of /original. Not on the real server's
  // contract yet — serves the same painted PNG the stub uses for
  // originals, since there is only one asset per image here.
  const imagePreview = url.pathname.match(/^\/images\/([^/]+)\/preview$/);
  if (imagePreview) {
    const img = images.find((i) => i.id === imagePreview[1]);
    if (!img || img.missing) return json(404, { reason: 'missing' });
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(paintImage(imagePreview[1] ?? ''));
    return;
  }
  const imageOne = url.pathname.match(/^\/images\/([^/]+)$/);
  if (imageOne && req.method === 'GET') {
    const img = images.find((i) => i.id === imageOne[1]);
    return img
      ? json(200, { ...img, boardId: img.boardId })
      : json(404, { reason: 'not found' });
  }
  if (imageOne && req.method === 'PATCH') {
    const img = images.find((i) => i.id === imageOne[1]);
    if (!img) return json(404, { reason: 'not found' });
    const body = await readJson<{ properties: Img['properties'] }>();
    img.properties = body.properties;
    return json(200, { properties: img.properties });
  }
  if (imageOne && req.method === 'DELETE') {
    const u = sessionUser(req.headers.cookie);
    if (!u) return json(401, { reason: 'sign in required' });
    const img = images.find((i) => i.id === imageOne[1]);
    if (!img) return json(404, { reason: 'not found' });
    const denied = imageForDeleting(u, img.boardId);
    if (denied) return json(403, denied);
    img.missing = true;
    return json(200, {});
  }

  // -- sheets ----------------------------------------------------------------------
  const sheetThreadAction = url.pathname.match(
    /^\/sheets\/([^/]+)\/(seen|archive|unarchive)$/,
  );
  if (sheetThreadAction && req.method === 'POST') {
    const u = sessionUser(req.headers.cookie);
    if (!u) return json(401, { reason: 'sign in required' });
    const id = sheetThreadAction[1] ?? '';
    if (!SHEET_NAME[id]) return json(404, { reason: 'not found' });
    const denied = boardForViewing(u, SHEET_BOARD[id] ?? 'b1');
    if (denied) return json(403, denied);
    if (sheetThreadAction[2] === 'seen') {
      const seenAt = new Date().toISOString();
      SHEET_READS.set(`${u}:${id}`, seenAt);
      return json(200, { seenAt });
    }
    if (sheetThreadAction[2] === 'archive') SHEET_ARCHIVED.add(id);
    else SHEET_ARCHIVED.delete(id);
    return json(200, { archived: SHEET_ARCHIVED.has(id) });
  }
  // Phase 2 (docs/phases/2-sheet.md section 6): imageCount + savedAt are
  // additive on top of phase 1's {id, name, createdAt} — the real server's
  // GET /boards/:id/sheets should grow the same two fields (see
  // web/README.md's note on the shape).
  const sheetsList = url.pathname.match(/^\/boards\/([^/]+)\/sheets$/);
  if (sheetsList && req.method === 'GET') {
    const u = sessionUser(req.headers.cookie);
    if (!u) return json(401, { reason: 'sign in required' });
    const boardId = sheetsList[1] ?? '';
    const denied = boardForViewing(u, boardId);
    if (denied) return json(403, denied);
    return json(
      200,
      Object.keys(SHEET_NAME)
        .filter((id) => (SHEET_BOARD[id] ?? 'b1') === boardId)
        .filter(
          (id) =>
            url.searchParams.get('archived') === '1' || !SHEET_ARCHIVED.has(id),
        )
        .map((id) => ({
          id,
          name: SHEET_NAME[id],
          createdAt: new Date().toISOString(),
          imageCount: (SHEET_IMAGES[id] ?? []).length,
          savedAt: sheetSavedAt[id] ?? null,
          archived: SHEET_ARCHIVED.has(id),
        })),
    );
  }
  if (sheetsList && req.method === 'POST') {
    const u = sessionUser(req.headers.cookie);
    if (!u) return json(401, { reason: 'sign in required' });
    const boardId = sheetsList[1] ?? '';
    const denied = boardForViewing(u, boardId); // boardForCreatingSheet: same rule
    if (denied) return json(403, denied);
    const body = await readJson<{
      name: string;
      imageIds: string[];
      // Phase 2 section 4: a sheet made from a neighbourhood carries
      // explicit CENTRES, one per imageId (shared/sheet/layout.ts's
      // ringLayout) — mirrors server/src/sheets/routes.ts's own reading of
      // this field exactly (SHEET_CELL/SHEET_FIT match that route's
      // CELL/FIT), so the stub is an honest stand-in for it.
      positions?: Record<string, { x: number; y: number }>;
    }>();
    const id = `s${sheetSeq++}`;
    SHEET_NAME[id] = body.name;
    SHEET_BOARD[id] = boardId;
    SHEET_CREATOR[id] = u;
    SHEET_IMAGES[id] = body.imageIds.map((imgId) =>
      Number(imgId.replace('img-', '')),
    );
    const ordered = body.imageIds
      .map((imgId) =>
        images.find((i) => i.id === imgId && i.boardId === boardId),
      )
      .filter((i): i is Img => !!i);
    const cols = Math.max(1, Math.ceil(Math.sqrt(ordered.length)));
    elementsBySheet[id] = ordered.map((img, i) => {
      const scale = fitScale(img.width, img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      const centre = body.positions?.[img.id];
      let x: number;
      let y: number;
      if (centre) {
        const placed = centreToTopLeft(centre, img.width, img.height);
        x = placed.x;
        y = placed.y;
      } else {
        const col = i % cols;
        const row = Math.floor(i / cols);
        x = col * SHEET_CELL + (SHEET_CELL - w) / 2;
        y = row * SHEET_CELL + (SHEET_CELL - h) / 2;
      }
      return el({
        id: `el-img-${img.id}`,
        type: 'image',
        x,
        y,
        width: w,
        height: h,
        fileId: fileId(img.id),
        customData: { kind: 'image', imageId: img.id },
        groupIds: [imageGroupId(img.id)],
      });
    });
    peersBySheet[id] = new Map();
    sheetSavedAt[id] = new Date().toISOString();
    return json(201, { id });
  }

  const sheetFootprintMatch = url.pathname.match(
    /^\/sheets\/([^/]+)\/footprint$/,
  );
  if (sheetFootprintMatch && req.method === 'GET') {
    const u = sessionUser(req.headers.cookie);
    if (!u) return json(401, { reason: 'sign in required' });
    const id = sheetFootprintMatch[1] ?? '';
    if (!SHEET_NAME[id]) return json(404, { reason: 'not found' });
    const denied = sheetForDeleting(u, id);
    if (denied) return json(403, denied);
    return json(200, { foreignViews: sheetFootprint(id) });
  }

  const sheetOne = url.pathname.match(/^\/sheets\/([^/]+)$/);
  if (sheetOne && req.method === 'PATCH') {
    const id = sheetOne[1] ?? '';
    if (!SHEET_NAME[id]) return json(404, { reason: 'not found' });
    const body = await readJson<{ name: string }>();
    SHEET_NAME[id] = body.name;
    return json(200, { name: SHEET_NAME[id] });
  }
  if (sheetOne && req.method === 'DELETE') {
    const u = sessionUser(req.headers.cookie);
    if (!u) return json(401, { reason: 'sign in required' });
    const id = sheetOne[1] ?? '';
    if (!SHEET_NAME[id]) return json(404, { reason: 'not found' });
    const denied = sheetForDeleting(u, id);
    if (denied) return json(403, denied);
    deleteSheetRows(id);
    return json(200, {});
  }
  if (sheetOne && req.method === 'GET') {
    const id = sheetOne[1] ?? '';
    if (!SHEET_NAME[id]) return json(404, { reason: 'not found' });
    const imgs = (SHEET_IMAGES[id] ?? []).map((slot) => {
      const img = images.find((i) => i.slot === slot && i.id === `img-${slot}`);
      return {
        id: `img-${slot}`,
        slot,
        width: img?.width ?? 256,
        height: img?.height ?? 256,
        name: img?.name ?? `image-${slot}`,
        missing: img?.missing ?? false,
      };
    });
    return json(200, {
      id,
      name: SHEET_NAME[id],
      boardId: SHEET_BOARD[id] ?? 'b1',
      images: imgs,
    });
  }
  if (/^\/sheets\/[^/]+\/elements$/.test(url.pathname)) {
    return json(200, {
      elements: elementsBySheet[url.pathname.split('/')[2] ?? ''] ?? [],
    });
  }
  if (/^\/sheets\/[^/]+\/foreign$/.test(url.pathname)) {
    return json(200, foreignFor(url.pathname.split('/')[2] ?? ''));
  }
  // CONTEXT.md "Reply": what people say about a claim, per sheet. In
  // memory, append-only, like the real table.
  const repliesMatch = url.pathname.match(
    /^\/sheets\/([^/]+)\/replies(?:\/([^/]+))?$/,
  );
  if (repliesMatch) {
    const u = sessionUser(req.headers.cookie);
    if (!u) return json(401, { reason: 'sign in required' });
    const sheetId = repliesMatch[1] ?? '';
    const list = repliesBySheet[sheetId] ?? [];
    repliesBySheet[sheetId] = list;
    if (req.method === 'GET' && !repliesMatch[2]) {
      return json(200, { replies: list.filter((r) => !r.deleted) });
    }
    if (req.method === 'POST' && !repliesMatch[2]) {
      const body = await readJson<{ elementId?: string; text?: string }>();
      const text = (body.text ?? '').trim();
      if (!body.elementId || !text || text.length > 2000)
        return json(400, {
          error: 'a reply needs a claim and 1 to 2000 characters',
        });
      const reply = {
        id: `reply-${++replySeq}`,
        elementId: body.elementId,
        by: { id: USERS[u].id, name: USERS[u].name },
        text,
        at: new Date().toISOString(),
        deleted: false,
      };
      list.push(reply);
      const { deleted: _deleted, ...shown } = reply;
      return json(201, shown);
    }
    if (req.method === 'DELETE' && repliesMatch[2]) {
      const reply = list.find(
        (r) =>
          r.id === repliesMatch[2] && !r.deleted && r.by.id === USERS[u].id,
      );
      if (!reply)
        return json(403, { reason: 'only its writer removes a reply' });
      reply.deleted = true;
      return json(200, { ok: true });
    }
  }
  if (/^\/sheets\/[^/]+\/reach$/.test(url.pathname)) {
    return json(200, reachFor(url.pathname.split('/')[2] ?? ''));
  }
  if (/^\/sheets\/[^/]+\/rows$/.test(url.pathname)) {
    const id = url.pathname.split('/')[2] ?? '';
    return json(200, project(id, elementsBySheet[id] ?? []));
  }
  if (url.pathname === '/stats')
    return json(200, { ...stats, foreignInScene: 0 });

  json(404, { reason: 'not found' });
});

const io = new SocketServer(httpServer, {
  cors: { origin: WEB_ORIGIN, credentials: true },
});

// Presence (docs/phases/2-sheet.md section 3): mirrors
// server/src/sheets/room.ts's own per-socket rate limit exactly, so a
// dry run against this stub exercises the same throttle shape the real
// server enforces.
const POINTER_RATE_PER_S = 20;

function peerList(sheetId: string): { id: string; name: string }[] {
  return Array.from(peersBySheet[sheetId]?.values() ?? []);
}
function peersPayloadFor(sheetId: string) {
  const list = peerList(sheetId);
  return { users: list.map((p) => p.id), peers: list };
}

io.on('connection', (socket: Socket) => {
  socket.on('join', ({ sheetId }: { sheetId: string }) => {
    if (!SHEET_NAME[sheetId]) {
      socket.emit('join-denied', { reason: 'not found' });
      socket.disconnect(true);
      return;
    }
    const cookieHeader = (socket.handshake.headers.cookie ?? '') as string;
    const m = cookieHeader.match(new RegExp(`${COOKIE_PREFIX}=([a-z]+)`));
    const u = (m?.[1] as UserKey | undefined) ?? null;
    const denied =
      u && USERS[u]
        ? boardForViewing(u, SHEET_BOARD[sheetId] ?? 'b1')
        : { reason: 'sign in required' };
    if (denied) {
      socket.emit('join-denied', denied);
      socket.disconnect(true);
      return;
    }
    socket.join(sheetId);
    socket.data.sheetId = sheetId;
    socket.data.userId = u ? USERS[u].id : socket.id;
    socket.data.userName = u ? USERS[u].name : '';
    if (!peersBySheet[sheetId]) peersBySheet[sheetId] = new Map();
    peersBySheet[sheetId]?.set(socket.id, {
      id: socket.data.userId,
      name: socket.data.userName,
    });
    socket.emit('joined', {
      elements: elementsBySheet[sheetId],
      peers: peerList(sheetId).map((p) => p.id),
    });
    io.to(sheetId).emit('peers', peersPayloadFor(sheetId));
  });

  socket.on('scene', ({ elements }: { elements: SceneElement[] }) => {
    const sheetId = socket.data.sheetId as string | undefined;
    if (!sheetId) return;
    elementsBySheet[sheetId] = elements;
    sheetSavedAt[sheetId] = new Date().toISOString();
    stats.scenes++;
    stats.broadcasts++;
    stats.snapshots++;
    socket.to(sheetId).emit('scene', { elements, from: socket.id });
  });

  // A peer's pointer (docs/phases/2-sheet.md section 3): relayed, never
  // persisted, rate-limited per socket exactly like room.ts.
  socket.on(
    'pointer',
    (payload: { x: number; y: number; selectedIds: string[] }) => {
      const sheetId = socket.data.sheetId as string | undefined;
      const userId = socket.data.userId as string | undefined;
      if (!sheetId || !userId) return;
      const now = Date.now();
      const windowStart = (socket.data.pointerWindowStart as number) || 0;
      if (now - windowStart >= 1000) {
        socket.data.pointerWindowStart = now;
        socket.data.pointerCount = 0;
      }
      socket.data.pointerCount =
        ((socket.data.pointerCount as number) || 0) + 1;
      if (socket.data.pointerCount > POINTER_RATE_PER_S) return;
      socket.to(sheetId).emit('pointer', {
        x: payload.x,
        y: payload.y,
        selectedIds: payload.selectedIds,
        user: userId,
        name: (socket.data.userName as string) || '',
      });
    },
  );

  socket.on('disconnect', () => {
    const sheetId = socket.data.sheetId as string | undefined;
    if (!sheetId) return;
    peersBySheet[sheetId]?.delete(socket.id);
    io.to(sheetId).emit('peers', peersPayloadFor(sheetId));
  });
});

httpServer.listen(PORT, () =>
  console.log(`digsite stub on http://localhost:${PORT}`),
);
