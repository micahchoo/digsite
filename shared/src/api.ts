// One request type and one response type per route in docs/design.md's
// "Routes" section, so web/ never spells a payload by hand, plus the
// Socket.IO event payloads for a sheet room. A GET with no body has no
// Request type. Binary routes (the tile PNG, the original image, and
// `GET /images/:id/preview` — the original scaled to <=1024px, or the
// image's S=128 ladder cell when there is no original) are not JSON and
// are not typed here. `web/src/lib/api.ts`'s `originalUrl` builder gets a
// `previewUrl` sibling the same way, not a typed field — neither route
// answers with a URL in a JSON body anywhere in this file today.

import type { SortKey } from './board/sort.ts';
import type { EdgeRow, Foreign, RegionRow } from './sheet/claims.ts';
import type { Properties } from './sheet/elements.ts';

export type Role = 'owner' | 'admin' | 'member';

// -- Groups --------------------------------------------------------------

export type CreateGroupRequest = { name: string };
export type CreateGroupResponse = { id: string };

export type Group = { id: string; name: string; role: Role };
export type ListGroupsResponse = Group[];

export type InviteRequest = { email: string };
// Phase 3 (docs/phases/3-groups.md section 1): widened with the join URL
// (`WEB_ORIGIN/join/<invitationId>`) the group page shows with a copy
// button — every existing reader of `invitationId` is unaffected.
export type InviteResponse = { invitationId: string; url: string };

export type AcceptInvitationResponse = { groupId: string };

export type Member = {
  userId: string;
  email: string;
  name: string;
  role: Role;
};
export type ListMembersResponse = Member[];

// Phase 3 section 1: GET /invitations/:id is public (no session) — the
// join page's preview before signing in or up.
export type GetInvitationResponse = {
  groupName: string;
  inviterName: string;
  open: boolean;
};

// Phase 3 section 1: GET /groups/:id/invitations, under groupForInviting.
export type PendingInvitation = {
  id: string;
  email: string | null;
  createdAt: string;
};
export type ListPendingInvitationsResponse = PendingInvitation[];

// Phase 3 section 2: PATCH /groups/:id/members/:userId, under
// groupForManagingMembers.
export type UpdateMemberRoleRequest = { role: Role };
export type UpdateMemberRoleResponse = { userId: string; role: Role };

// -- Boards ----------------------------------------------------------------

// Phase 3 section 5 (docs/phases/3-groups.md): GET /groups/:id/boards widens
// this with the group home's stats — every existing reader of
// id/name/open/imageCount is unaffected.
export type BoardSummary = {
  id: string;
  name: string;
  open: boolean;
  imageCount: number;
  groupId: string;
  sheetCount: number;
  lastActivity: string | null;
};
export type ListBoardsResponse = BoardSummary[];

export type CreateBoardRequest = { name: string; open: boolean };
export type CreateBoardResponse = { id: string };

export type SortableKey = { key: SortKey; label: string };
// Phase 3: widened with the board's group id, so a board page (which has no
// group id in its own URL) can fetch group members for the allowlist's
// "add" control.
export type GetBoardResponse = {
  id: string;
  name: string;
  open: boolean;
  imageCount: number;
  defaultSort: string;
  sortableKeys: SortableKey[];
  groupId: string;
};

export type UpdateBoardRequest = { defaultSort: string };
export type UpdateBoardResponse = { defaultSort: string };

// GET /boards/:id/find?sort=&q=&filter=; ranks drive map dimming, while
// the first SHEET_LIMIT matching ids can be added directly to selection.
export type FindFilterOp =
  | 'eq'
  | 'neq'
  | 'lt'
  | 'lte'
  | 'gt'
  | 'gte'
  | 'between'
  | 'in'
  | 'has';
export type FindFilterClause = {
  key: string;
  op: FindFilterOp;
  value: unknown;
};
export type FindBoardResponse = {
  ranks: number[];
  imageIds: string[];
  count: number;
};

export type AllowlistRequest = { userId: string };
export type AllowlistResponse = { userId: string }[];

// Phase 3 section 4: PATCH /boards/:id {name} — the same route as
// UpdateBoardRequest/Response above (defaultSort), branched on which field
// the body carries.
export type RenameBoardRequest = { name: string };
export type RenameBoardResponse = { name: string };

// Phase 3 section 4: DELETE confirmation counts, under boardForDeleting.
export type BoardFootprint = {
  images: number;
  sheets: number;
  regions: number;
  edges: number;
};
// Phase 3 section 4: DELETE /sheets/:id confirmation, under sheetForDeleting
// — count of OTHER sheets holding an image with a claim from this sheet.
export type SheetFootprint = { foreignViews: number };

// Phase 3 section 3: GET /boards/:id/allowlist, under boardForViewing.
export type GetBoardAllowlistResponse = { groupId: string; members: Member[] };

// Phase 2 section 4 (docs/phases/2-sheet.md): sheet-from-a-neighbourhood.
// `ids=<comma-separated image ids>` on GET /boards/:id/images answers with
// exactly those images, order preserved, each carrying its RANK under the
// `sort` param passed alongside it (via ensureRank first).
export type BoardImageWithRank = BoardImage & { rank?: number };
export type ListBoardImagesByIdsResponse = { images: BoardImageWithRank[] };

// Phase 2 section 4: GET /boards/:id/relations — distinct relations across
// every sheet's own edges on this board, for the Explore panel's relation
// filter.
export type GetBoardRelationsResponse = string[];

// Phase 3 section 5: recent sheets across boards a user can see, for the
// group home page.
export type RecentSheet = {
  id: string;
  name: string;
  boardId: string;
  boardName: string;
  savedAt: string | null;
};
export type ListRecentSheetsResponse = RecentSheet[];

// Phase 1 (docs/phases/1-map.md "Upload as a worker"): the request enqueues
// a ladder job and reports each image's status instead of always being
// ready. `status` is additive on this existing response type — every other
// field is unchanged.
export type UploadImagesResponse = {
  id: string;
  slot: number;
  status: 'ready' | 'pending' | 'failed';
}[];

export type BoardImage = {
  id: string;
  slot: number;
  name: string;
  width: number;
  height: number;
  uploadedAt: string;
  properties: Properties;
  missing: boolean;
  // Phase 1 (docs/phases/1-map.md "Upload as a worker"): additive on this
  // existing type. width/height are 0 while status is 'pending'.
  status: 'ready' | 'pending' | 'failed';
  error: string | null;
};
export type ListBoardImagesResponse = { images: BoardImage[] };

export type GetImageResponse = BoardImage & { boardId: string };

export type UpdateImagePropertiesRequest = { properties: Properties };
export type UpdateImagePropertiesResponse = { properties: Properties };

// Slice 2 (docs/ux/design.md §7 "Slice 2 — Board + selection" /
// docs/phases/6-product.md "Selection — the verb that moves pictures from
// the board to a sheet"): a selection is a set of IMAGE IDS, owned by the
// viewer, per board — never ranks, so a sort change never silently selects
// different pictures (`../../.claude/rules/ladder-slot-vs-rank.md`: "a
// selection on the map is a client overlay", the rank is only ever a lookup
// key into it). `imageIds` order is tray order (design.md §5.1 "the tray...
// order is selection order").
export type GetBoardSelectionResponse = { imageIds: string[] };
export type PutBoardSelectionRequest = { imageIds: string[] };
export type PutBoardSelectionResponse = { imageIds: string[] };

// POST /boards/:id/selection/range {sort, fromRank, toRank} — resolves a
// rank range to ids SERVER-SIDE (design.md §5.1: "Range and band selects
// resolve server-side... so a million-cell board never pages ranks to the
// client"). Capped at 5,000; `fromRank`/`toRank` may arrive in either
// order (a drag can run either direction).
export type SelectionRangeRequest = {
  sort: string;
  fromRank: number;
  toRank: number;
};
export type SelectionRangeResponse = { imageIds: string[] };

// -- Sheets ------------------------------------------------------------

// Phase 2 (docs/phases/2-sheet.md section 6): `imageCount`/`savedAt` are
// additive on the phase-1 shape — GET /boards/:id/sheets for the sheet
// list's stats. `savedAt` is null until the sheet's first snapshot.
export type SheetSummary = {
  id: string;
  name: string;
  createdAt: string;
  imageCount: number;
  savedAt: string | null;
  archived: boolean;
};
export type ListSheetsResponse = SheetSummary[];

// Slice 2 (docs/ux/design.md §7 "Slice 2 — Board + selection", follow-up b):
// GET /groups/:id/sheets — every sheet of every board the viewer can see in
// the group, one request. Replaces the shell's per-board `listSheets` loop
// (web/src/shell/useShellData.ts).
export type GroupSheetSummary = SheetSummary & {
  boardId: string;
  boardName: string;
};
export type ListGroupSheetsResponse = GroupSheetSummary[];

// Phase 6 thread browser: fuller group-wide sheet listing, including unread,
// archive state and the preview strip.
export type GroupThreadSummary = GroupSheetSummary & {
  lastActivityAt: string | null;
  unread: boolean;
  archived: boolean;
  previewImageIds: string[];
};
export type ListGroupThreadsResponse = GroupThreadSummary[];

// Group homepage guestbook activity and visible-board counters.
export type GroupActivityItem = {
  id: string;
  boardId: string | null;
  kind: string;
  actorId: string;
  actorName: string;
  payload: Record<string, unknown>;
  at: string;
};
export type ListGroupActivityResponse = GroupActivityItem[];
export type GroupStatsResponse = {
  images: number;
  sheets: number;
  members: number;
};

// PATCH /sheets/:id, under sheetForEditing (docs/phases/2-sheet.md section 6).
export type UpdateSheetRequest = { name: string };
export type UpdateSheetResponse = { name: string };
export type ArchiveSheetResponse = { archived: boolean };
export type MarkSheetSeenResponse = { seenAt: string };

export type CreateSheetRequest = {
  name: string;
  imageIds: string[];
  // Phase 2 section 4: a sheet made from a neighbourhood carries explicit
  // centres (e.g. shared/sheet/layout.ts's ringLayout), one per imageId.
  // Absent (or an id missing from the map) falls back to the grid layout.
  positions?: Record<string, { x: number; y: number }>;
};
export type CreateSheetResponse = { id: string };

// Slice 2 (docs/ux/design.md §7, §5.1 "What a selection can become"):
// POST /boards/:id/sheets/:sheetId/images — "Add to sheet…". Skips ids
// already on the sheet; the rest are placed to the right of the sheet's
// existing content (its own layout order, not the tray's).
export type AddImagesToSheetRequest = { imageIds: string[] };
export type AddImagesToSheetResponse = { added: string[]; skipped: string[] };

// Phase 2 section 6 / docs/phases/3-groups.md section 4: `name`/`missing`
// are additive, so the sheet can show a name and skip fetching a deleted
// original.
export type SheetImage = {
  id: string;
  slot: number;
  width: number;
  height: number;
  name: string;
  missing: boolean;
};
export type GetSheetResponse = {
  id: string;
  name: string;
  boardId: string;
  images: SheetImage[];
  // Phase 2 section 6: additive — null until the sheet's first snapshot.
  savedAt: string | null;
};

export type GetSheetElementsResponse = { elements: unknown[] };

export type GetSheetForeignResponse = Foreign;

export type GetSheetRowsResponse = { regions: RegionRow[]; edges: EdgeRow[] };

// GET /boards/:id/neighbourhood?from=<imageId>&hops=<1..3>&relation=<optional>
// (docs/phases/2-sheet.md section 4), under boardForViewing. `images` is
// breadth-first, nearest-first, capped at SHEET_LIMIT
// (shared/sheet/elements.ts); `truncated` says whether the cap cut it off.
// `edges` are the board's own edges (any sheet's) that join two images both
// present in `images`.
export type NeighbourhoodImage = { id: string; hops: number };
export type GetNeighbourhoodResponse = {
  images: NeighbourhoodImage[];
  edges: EdgeRow[];
  truncated: boolean;
};

export type GetStatsResponse = {
  scenes: number;
  broadcasts: number;
  snapshots: number;
  lastProjectionMs: number;
  foreignInScene: number;
};

// -- Socket.IO: the sheet room -------------------------------------------

/** Excalidraw's own element type is web's concern; shared only sees data. */
export type SceneElements = unknown[];

export type JoinPayload = { sheetId: string };
export type JoinedPayload = { elements: SceneElements; peers: string[] };
export type JoinDeniedPayload = { reason: string };
export type SceneClientPayload = { elements: SceneElements };
export type SceneServerPayload = { elements: SceneElements; from: string };

// Phase 5 section 2 (docs/phases/5-hardening.md "Abuse limits"): a socket
// past `socket-connect` (join) or `scene-emit` (scene) drops instead of
// erroring — `limited` names which bucket, distinct from `join-denied`
// (an access refusal, not a rate refusal).
export type LimitedPayload = { reason: 'socket-connect' | 'scene-emit' };

// Phase 2 section 3: additive — `peers` carries {id, name} objects for a
// named cursor and outline; `users` (ids only) stays for whatever already
// reads it.
export type PeersPayload = {
  users: string[];
  peers: { id: string; name: string }[];
};

// A client's own pointer, at most 20/s (server-enforced, extras dropped —
// docs/phases/2-sheet.md section 3); never persisted. The room relays it
// widened with who sent it.
export type PointerPayload = { x: number; y: number; selectedIds: string[] };
export type PointerBroadcastPayload = PointerPayload & {
  user: string;
  name: string;
};

// -- Phase 1: sections, forced rebuild ------------------------------------

/** GET /boards/:id/sections?sort=<sortId> — docs/phases/1-map.md
 * "Sections, hover, selection". Rank ranges cap at 500; `truncated` says
 * whether more existed. */
export type Section = { label: string; fromRank: number; toRank: number };
export type GetSectionsResponse = { sections: Section[]; truncated: boolean };

/** POST /boards/:id/sort/:sortId/rebuild — forces a rank rebuild and an
 * immediate materialise for that sort. */
export type RebuildSortResponse = { ok: true };

// -- Phase 5 section 4: worker operability --------------------------------

/** GET /boards/:id/jobs?state=<state> (default 'failed'), under
 * boardForManagingAllowlist — docs/phases/5-hardening.md section 4. `kind`
 * is one of worker/jobs.ts's job kinds ('ladder' | 'rank-rebuild' |
 * 'materialise'); `error` is the reason recorded on the last attempt
 * (null before any attempt has failed). */
export type JobSummary = {
  id: number;
  kind: string;
  state: string;
  attempts: number;
  error: string | null;
  runAfter: string;
  createdAt: string;
};
export type ListJobsResponse = JobSummary[];

/** POST /jobs/:id/retry, same intent — resets a failed job to pending,
 * attempts 0, due now. */
export type RetryJobResponse = { ok: true };
