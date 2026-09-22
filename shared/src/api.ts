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

export type SheetSummary = { id: string; name: string; createdAt: string };
export type ListSheetsResponse = SheetSummary[];

export type CreateSheetRequest = { name: string; imageIds: string[] };
export type CreateSheetResponse = { id: string };

export type SheetImage = {
  id: string;
  slot: number;
  width: number;
  height: number;
};
export type GetSheetResponse = {
  id: string;
  name: string;
  boardId: string;
  images: SheetImage[];
};

export type GetSheetElementsResponse = { elements: unknown[] };

export type GetSheetForeignResponse = Foreign;

export type GetSheetRowsResponse = { regions: RegionRow[]; edges: EdgeRow[] };

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
export type PeersPayload = { users: string[] };

// -- Phase 1: sections, forced rebuild ------------------------------------

/** GET /boards/:id/sections?sort=<sortId> — docs/phases/1-map.md
 * "Sections, hover, selection". Rank ranges cap at 500; `truncated` says
 * whether more existed. */
export type Section = { label: string; fromRank: number; toRank: number };
export type GetSectionsResponse = { sections: Section[]; truncated: boolean };

/** POST /boards/:id/sort/:sortId/rebuild — forces a rank rebuild and an
 * immediate materialise for that sort. */
export type RebuildSortResponse = { ok: true };
