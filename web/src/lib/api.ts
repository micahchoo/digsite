// The one place web spells an HTTP request. Every function here returns one
// of shared/src/api.ts's response types, so a payload shape is never guessed
// twice. `credentials: 'include'` on every call — the session lives in a
// cookie (docs/design.md "web/").

import type {
  AcceptInvitationResponse,
  AddImagesToSheetRequest,
  AddImagesToSheetResponse,
  AllowlistRequest,
  AllowlistResponse,
  ArchiveSheetResponse,
  BoardImage,
  BoardSummary,
  CreateBoardRequest,
  CreateBoardResponse,
  CreateGroupRequest,
  CreateGroupResponse,
  CreateSheetRequest,
  CreateSheetResponse,
  FindBoardResponse,
  FindFilterClause,
  GetBoardResponse,
  GetBoardSelectionResponse,
  GetImageResponse,
  GetNeighbourhoodResponse,
  GetSectionsResponse,
  GetSheetElementsResponse,
  GetSheetForeignResponse,
  GetSheetResponse,
  GetSheetRowsResponse,
  GetStatsResponse,
  InviteRequest,
  InviteResponse,
  ListBoardImagesResponse,
  ListGroupSheetsResponse,
  ListGroupThreadsResponse,
  ListGroupsResponse,
  ListMembersResponse,
  MarkSheetSeenResponse,
  Member,
  PutBoardSelectionRequest,
  PutBoardSelectionResponse,
  Role,
  SelectionRangeRequest,
  SelectionRangeResponse,
  SheetSummary,
  UpdateBoardRequest,
  UpdateBoardResponse,
  UpdateImagePropertiesRequest,
  UpdateImagePropertiesResponse,
  UploadImagesResponse,
} from '@digsite/shared/api';

export const SERVER_ORIGIN: string =
  (import.meta.env.VITE_SERVER_ORIGIN as string | undefined) ??
  'http://localhost:8800';

/** `BoardImage['status']` under its own name — board/upload.ts's poll loop
 * and the upload rows both want to say "a status", not spell out the union
 * every time. */
export type ImageStatus = BoardImage['status'];

// Phase 2 (docs/phases/2-sheet.md section 6): the sheet list's stats and
// rename aren't in @digsite/shared/api yet (same TODO as sections/upload
// status above) — the real server's ListSheetsResponse should grow
// `imageCount`/`savedAt` to match `SheetSummaryWithStats` below, and add an
// `UpdateSheetRequest`/`Response` pair for `PATCH /sheets/:id`.
export type SheetSummaryWithStats = SheetSummary & {
  imageCount: number;
  savedAt: string | null;
  unread?: boolean;
};
export type ListSheetsWithStatsResponse = SheetSummaryWithStats[];
export type UpdateSheetRequest = { name: string };
export type UpdateSheetResponse = { name: string };

// Phase 3 (docs/phases/3-groups.md): invitation links, role management,
// allowlist display, footprints and rename/delete — none of this is in
// @digsite/shared/api yet, same TODO pattern as above. The real server's
// routes should grow to match these shapes exactly (see this file's report
// back to the lead for the full list).
export type GetInvitationResponse = {
  groupName: string;
  inviterName: string;
  open: boolean;
};
/** `POST /groups/:id/invite` — additive on top of shared's InviteResponse:
 * the join URL the group page shows with a copy button. */
export type InviteResponseWithUrl = InviteResponse & { url: string };
export type PendingInvitation = {
  id: string;
  email: string | null;
  createdAt: string;
};
export type ListPendingInvitationsResponse = PendingInvitation[];

export type UpdateMemberRoleRequest = { role: Role };
export type UpdateMemberRoleResponse = { userId: string; role: Role };

export type GetBoardAllowlistResponse = { groupId: string; members: Member[] };

export type BoardFootprint = {
  images: number;
  sheets: number;
  regions: number;
  edges: number;
};
export type SheetFootprint = { foreignViews: number };

export type RenameBoardRequest = { name: string };
export type RenameBoardResponse = { name: string };

/** `GET /groups/:id/boards` — additive on top of shared's BoardSummary for
 * the group home (docs/phases/3-groups.md section 5): sheet count and last
 * activity, plus the group id every board already knows since boards live
 * in exactly one group. */
export type BoardSummaryWithStats = BoardSummary & {
  groupId: string;
  sheetCount: number;
  lastActivity: string | null;
};
export type ListBoardsWithStatsResponse = BoardSummaryWithStats[];

/** `GET /boards/:id` — additive: the board's group id, so the board page
 * (which has no group id in its own URL) can fetch group members for the
 * allowlist's "add" control. */
export type GetBoardResponseWithGroup = GetBoardResponse & { groupId: string };

export type RecentSheet = {
  id: string;
  name: string;
  boardId: string;
  boardName: string;
  savedAt: string | null;
};
export type ListRecentSheetsResponse = RecentSheet[];

/** `GET /sheets/:id` — additive per-image `name`/`missing`, so the sheet
 * can load a placeholder file instead of fetching a deleted original
 * (docs/phases/3-groups.md section 4). */
export type SheetImageWithStatus = {
  id: string;
  slot: number;
  width: number;
  height: number;
  name: string;
  missing: boolean;
};
export type GetSheetResponseWithStatus = Omit<GetSheetResponse, 'images'> & {
  images: SheetImageWithStatus[];
};

// Phase 2 section 4 (docs/phases/2-sheet.md): sheet-from-a-neighbourhood.
// Two params `GET /boards/:id/images` does not have on the real server
// today — see this file's report back to the lead:
//
// - `ids=<comma-separated image ids>`: an explicit id list, order
//   preserved, ignoring `from`/`count`. Needed so Board.tsx's
//   `selectImages(ids)` can turn a neighbourhood's image ids into a map
//   selection with ONE call instead of one `GET /images/:id` per id.
// - a `rank` on each returned `BoardImage`, present only when `ids` was
//   used, computed against the `sort` param passed alongside it — the
//   caller already knows the sort it wants ranks for.
//
// `GET /boards/:id/relations` — distinct edge relations on the board
// (union of every sheet's own edges), for the Explore panel's relation
// filter. Also not on the real server today; until it exists (or if this
// call 404s) the panel derives relations from a neighbourhood response's
// own edges instead (docs/phases/2-sheet.md section 4's own fallback).
export type BoardImageWithRank = BoardImage & { rank?: number };
export type ListBoardImagesByIdsResponse = { images: BoardImageWithRank[] };

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly reason: string,
    /** `X-Request-Id` (server/src/app.ts sets it on every response) or, for
     * an uncaught 500, the same id repeated in the JSON body
     * (`{error, requestId}` — server/src/http.ts). Null when the response
     * carried neither, e.g. a stub or a proxy in front that stripped the
     * header. ErrorState.tsx shows it on a 500 so a report to an operator
     * can be tied back to a server log line without exposing anything else
     * about the failure. */
    public readonly requestId: string | null = null,
  ) {
    super(reason);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const isForm = init.body instanceof FormData;
  const headers: Record<string, string> = {};
  if (init.body !== undefined && !isForm) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(`${SERVER_ORIGIN}${path}`, {
    credentials: 'include',
    ...init,
    headers: { ...headers, ...(init.headers as Record<string, string>) },
  });

  if (!res.ok) {
    let reason = res.statusText;
    let requestId = res.headers.get('X-Request-Id');
    try {
      const body = (await res.json()) as {
        reason?: string;
        error?: string;
        requestId?: string;
      };
      if (body.reason) reason = body.reason;
      else if (body.error) reason = body.error;
      if (body.requestId) requestId = body.requestId;
    } catch {
      // no JSON body; keep statusText
    }
    throw new ApiError(res.status, reason, requestId);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function post(body: unknown): RequestInit {
  return { method: 'POST', body: JSON.stringify(body) };
}

function patch(body: unknown): RequestInit {
  return { method: 'PATCH', body: JSON.stringify(body) };
}

function put(body: unknown): RequestInit {
  return { method: 'PUT', body: JSON.stringify(body) };
}

export const api = {
  // -- groups --------------------------------------------------------------
  createGroup: (body: CreateGroupRequest) =>
    request<CreateGroupResponse>('/groups', post(body)),
  listGroups: () => request<ListGroupsResponse>('/groups'),
  // `Partial<InviteRequest>` rather than the shared type's required
  // `email: string`: docs/ux/audit.md #7's fix is to omit the key
  // entirely for a link-only invite, not send `email: ''` — the field the
  // real server 500s on today. Group.tsx's `sendInvite` builds the body
  // that way; this signature just has to allow it.
  invite: (groupId: string, body: Partial<InviteRequest>) =>
    request<InviteResponseWithUrl>(`/groups/${groupId}/invite`, post(body)),
  listPendingInvitations: (groupId: string) =>
    request<ListPendingInvitationsResponse>(`/groups/${groupId}/invitations`),
  getInvitation: (invitationId: string) =>
    request<GetInvitationResponse>(`/invitations/${invitationId}`),
  revokeInvitation: (invitationId: string) =>
    request<void>(`/invitations/${invitationId}`, { method: 'DELETE' }),
  acceptInvitation: (invitationId: string) =>
    request<AcceptInvitationResponse>(`/invitations/${invitationId}/accept`, {
      method: 'POST',
    }),
  leaveGroup: (groupId: string) =>
    request<void>(`/groups/${groupId}/leave`, { method: 'POST' }),
  updateMemberRole: (
    groupId: string,
    userId: string,
    body: UpdateMemberRoleRequest,
  ) =>
    request<UpdateMemberRoleResponse>(
      `/groups/${groupId}/members/${userId}`,
      patch(body),
    ),
  removeMember: (groupId: string, userId: string) =>
    request<void>(`/groups/${groupId}/members/${userId}`, {
      method: 'DELETE',
    }),
  listMembers: (groupId: string) =>
    request<ListMembersResponse>(`/groups/${groupId}/members`),
  listRecentSheets: (groupId: string) =>
    request<ListRecentSheetsResponse>(`/groups/${groupId}/sheets/recent`),
  // Slice 2 follow-up (b): every sheet of every board the viewer can see in
  // the group, one request — replaces the shell's per-board `listSheets`
  // loop (shell/useShellData.ts).
  listGroupSheets: (groupId: string) =>
    request<ListGroupSheetsResponse>(`/groups/${groupId}/sheets`),
  listGroupThreads: (groupId: string, includeArchived = false) =>
    request<ListGroupThreadsResponse>(
      `/groups/${groupId}/sheets${includeArchived ? '?archived=1' : ''}`,
    ),

  // -- boards ----------------------------------------------------------------
  listBoards: (groupId: string) =>
    request<ListBoardsWithStatsResponse>(`/groups/${groupId}/boards`),
  createBoard: (groupId: string, body: CreateBoardRequest) =>
    request<CreateBoardResponse>(`/groups/${groupId}/boards`, post(body)),
  getBoard: (boardId: string) =>
    request<GetBoardResponseWithGroup>(`/boards/${boardId}`),
  updateBoard: (boardId: string, body: UpdateBoardRequest) =>
    request<UpdateBoardResponse>(`/boards/${boardId}`, patch(body)),
  renameBoard: (boardId: string, body: RenameBoardRequest) =>
    request<RenameBoardResponse>(`/boards/${boardId}`, patch(body)),
  deleteBoard: (boardId: string) =>
    request<void>(`/boards/${boardId}`, { method: 'DELETE' }),
  getBoardFootprint: (boardId: string) =>
    request<BoardFootprint>(`/boards/${boardId}/footprint`),
  getBoardAllowlist: (boardId: string) =>
    request<GetBoardAllowlistResponse>(`/boards/${boardId}/allowlist`),
  addToAllowlist: (boardId: string, body: AllowlistRequest) =>
    request<AllowlistResponse>(`/boards/${boardId}/allowlist`, post(body)),
  removeFromAllowlist: (boardId: string, userId: string) =>
    request<AllowlistResponse>(`/boards/${boardId}/allowlist/${userId}`, {
      method: 'DELETE',
    }),
  uploadImages: (boardId: string, files: File[]) => {
    const form = new FormData();
    for (const file of files) form.append('files', file);
    return request<UploadImagesResponse>(`/boards/${boardId}/images`, {
      method: 'POST',
      body: form,
    });
  },
  listBoardImages: (
    boardId: string,
    sort: string,
    from: number,
    count: number,
  ) =>
    request<ListBoardImagesResponse>(
      `/boards/${boardId}/images?sort=${encodeURIComponent(sort)}&from=${from}&count=${count}`,
    ),
  getSections: (boardId: string, sort: string) =>
    request<GetSectionsResponse>(
      `/boards/${boardId}/sections?sort=${encodeURIComponent(sort)}`,
    ),
  findBoard: (
    boardId: string,
    sort: string,
    q: string,
    filters: FindFilterClause[],
  ) => {
    const params = new URLSearchParams({ sort, q });
    if (filters.length) params.set('filter', JSON.stringify(filters));
    return request<FindBoardResponse>(
      `/boards/${boardId}/find?${params.toString()}`,
    );
  },
  // Phase 2 section 4: see ListBoardImagesByIdsResponse's header comment —
  // `ids`/per-image `rank` are not in the real server's contract yet.
  getBoardImagesByIds: (boardId: string, sort: string, ids: string[]) =>
    request<ListBoardImagesByIdsResponse>(
      `/boards/${boardId}/images?sort=${encodeURIComponent(sort)}&ids=${ids.map(encodeURIComponent).join(',')}`,
    ),
  getNeighbourhood: (
    boardId: string,
    from: string,
    hops: number,
    relation?: string,
  ) =>
    request<GetNeighbourhoodResponse>(
      `/boards/${boardId}/neighbourhood?from=${encodeURIComponent(from)}&hops=${hops}${
        relation ? `&relation=${encodeURIComponent(relation)}` : ''
      }`,
    ),
  // Not in the real server's contract yet — see ListBoardImagesByIdsResponse's
  // header comment. Board.tsx's Explore panel falls back to deriving
  // relations from a neighbourhood response when this 404s.
  getBoardRelations: (boardId: string) =>
    request<string[]>(`/boards/${boardId}/relations`),
  getImage: (imageId: string) =>
    request<GetImageResponse>(`/images/${imageId}`),
  originalUrl: (imageId: string) =>
    `${SERVER_ORIGIN}/images/${imageId}/original`,
  // Phase 2 section 7 (docs/phases/2-sheet.md): the sheet canvas loads a
  // preview, not the original — not in the real server's contract yet (the
  // stub serves the same painted PNG for both); see this file's report back
  // to the lead alongside the other TODOs above.
  previewUrl: (imageId: string) => `${SERVER_ORIGIN}/images/${imageId}/preview`,
  updateImageProperties: (
    imageId: string,
    body: UpdateImagePropertiesRequest,
  ) =>
    request<UpdateImagePropertiesResponse>(`/images/${imageId}`, patch(body)),
  deleteImage: (imageId: string) =>
    request<void>(`/images/${imageId}`, { method: 'DELETE' }),
  tileUrl: (boardId: string, sortId: string, z: number, x: number, y: number) =>
    `${SERVER_ORIGIN}/boards/${boardId}/tiles/${sortId}/${z}/${x}/${y}.png`,
  // Slice 2 (docs/ux/design.md §7 "Slice 2 — Board + selection"): the
  // selection is a durable object, ids not ranks, per (board, viewer).
  getBoardSelection: (boardId: string) =>
    request<GetBoardSelectionResponse>(`/boards/${boardId}/selection`),
  putBoardSelection: (boardId: string, body: PutBoardSelectionRequest) =>
    request<PutBoardSelectionResponse>(
      `/boards/${boardId}/selection`,
      put(body),
    ),
  postSelectionRange: (boardId: string, body: SelectionRangeRequest) =>
    request<SelectionRangeResponse>(
      `/boards/${boardId}/selection/range`,
      post(body),
    ),
  addSheetImages: (
    boardId: string,
    sheetId: string,
    body: AddImagesToSheetRequest,
  ) =>
    request<AddImagesToSheetResponse>(
      `/boards/${boardId}/sheets/${sheetId}/images`,
      post(body),
    ),

  // -- sheets ------------------------------------------------------------
  listSheets: (boardId: string, includeArchived = false) =>
    request<ListSheetsWithStatsResponse>(
      `/boards/${boardId}/sheets${includeArchived ? '?archived=1' : ''}`,
    ),
  markSheetSeen: (sheetId: string) =>
    request<MarkSheetSeenResponse>(`/sheets/${sheetId}/seen`, post({})),
  archiveSheet: (sheetId: string) =>
    request<ArchiveSheetResponse>(`/sheets/${sheetId}/archive`, post({})),
  unarchiveSheet: (sheetId: string) =>
    request<ArchiveSheetResponse>(`/sheets/${sheetId}/unarchive`, post({})),
  createSheet: (boardId: string, body: CreateSheetRequest) =>
    request<CreateSheetResponse>(`/boards/${boardId}/sheets`, post(body)),
  getSheet: (sheetId: string) =>
    request<GetSheetResponseWithStatus>(`/sheets/${sheetId}`),
  updateSheet: (sheetId: string, body: UpdateSheetRequest) =>
    request<UpdateSheetResponse>(`/sheets/${sheetId}`, patch(body)),
  deleteSheet: (sheetId: string) =>
    request<void>(`/sheets/${sheetId}`, { method: 'DELETE' }),
  getSheetFootprint: (sheetId: string) =>
    request<SheetFootprint>(`/sheets/${sheetId}/footprint`),
  getSheetElements: (sheetId: string) =>
    request<GetSheetElementsResponse>(`/sheets/${sheetId}/elements`),
  getSheetForeign: (sheetId: string) =>
    request<GetSheetForeignResponse>(`/sheets/${sheetId}/foreign`),
  getSheetRows: (sheetId: string) =>
    request<GetSheetRowsResponse>(`/sheets/${sheetId}/rows`),
  getStats: () => request<GetStatsResponse>('/stats'),
};
