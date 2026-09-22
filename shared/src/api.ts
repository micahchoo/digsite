// One request type and one response type per route in docs/design.md's
// "Routes" section, so web/ never spells a payload by hand, plus the
// Socket.IO event payloads for a sheet room. A GET with no body has no
// Request type. Binary routes (the tile PNG, the original image) are not
// JSON and are not typed here.

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
export type InviteResponse = { invitationId: string };

export type AcceptInvitationResponse = { groupId: string };

export type Member = {
  userId: string;
  email: string;
  name: string;
  role: Role;
};
export type ListMembersResponse = Member[];

// -- Boards ----------------------------------------------------------------

export type BoardSummary = {
  id: string;
  name: string;
  open: boolean;
  imageCount: number;
};
export type ListBoardsResponse = BoardSummary[];

export type CreateBoardRequest = { name: string; open: boolean };
export type CreateBoardResponse = { id: string };

export type SortableKey = { key: SortKey; label: string };
export type GetBoardResponse = {
  id: string;
  name: string;
  open: boolean;
  imageCount: number;
  defaultSort: string;
  sortableKeys: SortableKey[];
};

export type UpdateBoardRequest = { defaultSort: string };
export type UpdateBoardResponse = { defaultSort: string };

export type AllowlistRequest = { userId: string };
export type AllowlistResponse = { userId: string }[];

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
};
export type ListSheetsResponse = SheetSummary[];

// PATCH /sheets/:id, under sheetForEditing (docs/phases/2-sheet.md section 6).
export type UpdateSheetRequest = { name: string };
export type UpdateSheetResponse = { name: string };

export type CreateSheetRequest = {
  name: string;
  imageIds: string[];
  // Phase 2 section 4: a sheet made from a neighbourhood carries explicit
  // centres (e.g. shared/sheet/layout.ts's ringLayout), one per imageId.
  // Absent (or an id missing from the map) falls back to the grid layout.
  positions?: Record<string, { x: number; y: number }>;
};
export type CreateSheetResponse = { id: string };

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
