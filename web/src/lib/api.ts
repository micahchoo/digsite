// The one place web spells an HTTP request. Every function here returns one
// of shared/src/api.ts's response types, so a payload shape is never guessed
// twice. `credentials: 'include'` on every call — the session lives in a
// cookie (docs/design.md "web/").

import type { TermKind } from '@digsite/shared';
import type {
  AcceptInvitationResponse,
  AddImagesToSheetRequest,
  AddImagesToSheetResponse,
  AddReplyResponse,
  AliasesResponse,
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
  FolderImport,
  GetBoardResponse,
  GetBoardSelectionResponse,
  GetBoardVocabularyResponse,
  GetGroupResponse,
  GetImageResponse,
  GetNeighbourhoodResponse,
  GetRepliesResponse,
  GetSectionsResponse,
  GetSheetElementsResponse,
  GetSheetForeignResponse,
  GetSheetReachResponse,
  GetSheetResponse,
  GetSheetRowsResponse,
  GetStatsResponse,
  InviteRequest,
  InviteResponse,
  LabelSuggestionsResponse,
  ListBoardImagesResponse,
  ListGroupSheetsResponse,
  ListGroupThreadsResponse,
  ListGroupsResponse,
  ListMembersResponse,
  MarkSheetSeenResponse,
  MeaningResponse,
  Member,
  PutAliasRequest,
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
  UploadImageStatusesResponse,
  UploadImagesResponse,
} from '@digsite/shared/api';
import { GRID_LAYOUT_VERSION } from '@digsite/shared/board/grid';
import { boardAndSortOf, noteOrderVersion } from './order-version.ts';

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
    public readonly retryAfter: number | null = null,
    /** The refusal's JSON body, for a caller that reads more than the
     * reason: a full group's `usedBytes` and `quotaBytes`, say. */
    public readonly body: unknown = null,
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
  // Every answer in ranks names the build it came from, a refusal too
  // (a 409 from a range selection carries the new one).
  const token = res.headers.get('X-Order-Version');
  if (token) {
    const about = boardAndSortOf(path, init.body);
    if (about) noteOrderVersion(about.boardId, about.sort, token);
  }

  if (!res.ok) {
    let reason = res.statusText;
    let requestId = res.headers.get('X-Request-Id');
    let retryAfter = Number(res.headers.get('Retry-After') ?? Number.NaN);
    let parsed: unknown = null;
    try {
      parsed = await res.json();
      const body = parsed as {
        reason?: string;
        error?: string;
        requestId?: string;
        retryAfter?: number;
      };
      if (body.reason) reason = body.reason;
      else if (body.error) reason = body.error;
      if (body.requestId) requestId = body.requestId;
      if (typeof body.retryAfter === 'number') retryAfter = body.retryAfter;
    } catch {
      // no JSON body; keep statusText
    }
    throw new ApiError(
      res.status,
      reason,
      requestId,
      Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : null,
      parsed,
    );
  }

  if (res.status === 204) return undefined as T;
  const body = (await res.json()) as T;
  if (token && typeof body === 'object' && body !== null)
    builds.set(body, token);
  return body;
}

/** Which order build an answer in ranks came from, as its reply named it. */
const builds = new WeakMap<object, string>();
export function buildOf(answer: object): string | undefined {
  return builds.get(answer);
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
  /** One group and how much of its storage it uses. */
  getGroup: (groupId: string) =>
    request<GetGroupResponse>(`/groups/${groupId}`),
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
  uploadImages: (boardId: string, files: File[], signal?: AbortSignal) => {
    const form = new FormData();
    for (const file of files) form.append('files', file);
    return request<UploadImagesResponse>(`/boards/${boardId}/images?wait=0`, {
      method: 'POST',
      body: form,
      signal,
    });
  },
  uploadImageStatuses: (boardId: string, ids: string[], signal?: AbortSignal) =>
    request<UploadImageStatusesResponse>(`/boards/${boardId}/images/status`, {
      ...post({ ids }),
      signal,
    }),
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
    claims: { label?: string; relation?: string; annotated?: boolean } = {},
  ) => {
    const params = new URLSearchParams({ sort, q });
    if (filters.length) params.set('filter', JSON.stringify(filters));
    if (claims.label) params.set('label', claims.label);
    if (claims.relation) params.set('relation', claims.relation);
    if (claims.annotated) params.set('annotated', '1');
    return request<FindBoardResponse>(
      `/boards/${boardId}/find?${params.toString()}`,
    );
  },
  /** Pictures whose content matches the words, best first (search by
   * meaning). Scores sit close together, so the order is the answer. */
  searchMeaning: (boardId: string, sort: string, text: string, limit = 200) =>
    request<MeaningResponse>(
      `/boards/${boardId}/search?${new URLSearchParams({ text, sort, limit: String(limit) })}`,
    ),
  /** Pictures that look like `imageId`, best first. */
  similarImages: (
    boardId: string,
    sort: string,
    imageId: string,
    limit = 200,
  ) =>
    request<MeaningResponse>(
      `/boards/${boardId}/similar?${new URLSearchParams({ image: imageId, sort, limit: String(limit) })}`,
    ),
  // CONTEXT.md "Reply": what people say about a claim, per sheet.
  getReplies: (sheetId: string) =>
    request<GetRepliesResponse>(`/sheets/${sheetId}/replies`),
  addReply: (sheetId: string, elementId: string, text: string) =>
    request<AddReplyResponse>(`/sheets/${sheetId}/replies`, {
      method: 'POST',
      body: JSON.stringify({ elementId, text }),
    }),
  deleteReply: (sheetId: string, replyId: string) =>
    request<{ ok: true }>(`/sheets/${sheetId}/replies/${replyId}`, {
      method: 'DELETE',
    }),
  /** A region of a picture made into a picture of its own on its board
   * (CONTEXT.md "Extract"); 202 like an upload, pending until read. */
  extractRegion: (
    imageId: string,
    body: { fx: number; fy: number; fw: number; fh: number; label: string },
  ) =>
    request<{ id: string; name: string; width: number; height: number }>(
      `/images/${imageId}/extract`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  /** Pictures that are nearly this one, in meaning and in pixels
   * (CONTEXT.md "Near-duplicate"): suggestions a person accepts or not. */
  nearDuplicates: (boardId: string, sort: string, imageId: string) =>
    request<MeaningResponse>(
      `/boards/${boardId}/duplicates?${new URLSearchParams({ image: imageId, sort })}`,
    ),
  /** Labels this board already uses, scored against a picture. */
  labelSuggestions: (boardId: string, imageId: string, limit = 5) =>
    request<LabelSuggestionsResponse>(
      `/boards/${boardId}/label-suggestions?${new URLSearchParams({ image: imageId, limit: String(limit) })}`,
    ),
  startFolderImport: (boardId: string, path: string) =>
    request<FolderImport>(`/boards/${boardId}/imports`, {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),
  getFolderImport: (boardId: string, importId: string) =>
    request<FolderImport>(`/boards/${boardId}/imports/${importId}`),
  /** Goes on with an import the group's storage stopped; 409 if it is not
   * stopped. */
  resumeFolderImport: (boardId: string, importId: string) =>
    request<FolderImport>(
      `/boards/${boardId}/imports/${importId}/resume`,
      post({}),
    ),
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
  // CONTEXT.md "Vocabulary" and "Alias".
  getVocabulary: (boardId: string) =>
    request<GetBoardVocabularyResponse>(`/boards/${boardId}/vocabulary`),
  putAlias: (boardId: string, body: PutAliasRequest) =>
    request<AliasesResponse>(`/boards/${boardId}/aliases`, put(body)),
  deleteAlias: (boardId: string, kind: TermKind, term: string) =>
    request<AliasesResponse>(
      `/boards/${boardId}/aliases/${kind}/${encodeURIComponent(term)}`,
      { method: 'DELETE' },
    ),
  getImage: (imageId: string) =>
    request<GetImageResponse>(`/images/${imageId}`),
  originalUrl: (imageId: string) =>
    `${SERVER_ORIGIN}/images/${imageId}/original`,
  /** The camera file a picture was made from (HEIC, RAW), when it kept one:
   * `BoardImage.source` says whether. Downloads as `<name>.<format>`. */
  sourceUrl: (imageId: string) => `${SERVER_ORIGIN}/images/${imageId}/source`,
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
  /** With `v`, the order build the tile must be drawn from: a matching
   * final tile may then be cached for a year (order-version.ts). */
  tileUrl: (
    boardId: string,
    sortId: string,
    z: number,
    x: number,
    y: number,
    v?: string,
  ) =>
    `${SERVER_ORIGIN}/boards/${boardId}/tiles/${sortId}/${z}/${x}/${y}.png?grid=${GRID_LAYOUT_VERSION}${v ? `&v=${encodeURIComponent(v)}` : ''}`,
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
  getSheetReach: (sheetId: string) =>
    request<GetSheetReachResponse>(`/sheets/${sheetId}/reach`),
  getSheetRows: (sheetId: string) =>
    request<GetSheetRowsResponse>(`/sheets/${sheetId}/rows`),
  getStats: () => request<GetStatsResponse>('/stats'),
};
