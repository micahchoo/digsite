// The one place web spells an HTTP request. Every function here returns one
// of shared/src/api.ts's response types, so a payload shape is never guessed
// twice. `credentials: 'include'` on every call — the session lives in a
// cookie (docs/design.md "web/").

import type {
  Fraction,
  ReportChanges,
  ReportData,
  ReportScope,
  TermKind,
} from '@digsite/shared';
import type {
  AcceptInvitationResponse,
  AddImagesToSheetRequest,
  AddImagesToSheetResponse,
  AddReplyResponse,
  AliasesResponse,
  AllowlistRequest,
  AllowlistResponse,
  ArchiveSheetResponse,
  BoardFootprint,
  BoardImage,
  BoardSummary,
  CopyImagesRequest,
  CopyImagesResponse,
  CreateBoardRequest,
  CreateBoardResponse,
  CreateGroupRequest,
  CreateGroupResponse,
  CreateSheetRequest,
  CreateSheetResponse,
  FindBoardResponse,
  FindFilterClause,
  FolderImport,
  GetBoardAllowlistResponse,
  GetBoardResponse,
  GetBoardSelectionResponse,
  GetBoardVocabularyResponse,
  GetGroupResponse,
  GetImageResponse,
  GetInvitationResponse,
  GetNeighbourhoodResponse,
  GetRepliesResponse,
  GetSectionsResponse,
  GetSheetElementsResponse,
  GetSheetForeignResponse,
  GetSheetReachResponse,
  GetSheetResponse,
  GetSheetRowsResponse,
  GetStatsResponse,
  ImageMetadata,
  InviteRequest,
  InviteResponse,
  LabelSuggestionsResponse,
  ListAccountsResponse,
  ListBoardImagesByIdsResponse,
  ListBoardImagesResponse,
  ListBoardsResponse,
  ListGroupSheetsResponse,
  ListGroupThreadsResponse,
  ListGroupsResponse,
  ListMembersResponse,
  ListPendingInvitationsResponse,
  ListRecentSheetsResponse,
  ListReportsResponse,
  ListSheetsResponse,
  MarkSheetSeenResponse,
  MeaningResponse,
  Member,
  OperatorResponse,
  PutAliasRequest,
  PutBoardSelectionRequest,
  PutBoardSelectionResponse,
  RenameBoardRequest,
  RenameBoardResponse,
  Role,
  SelectionRangeRequest,
  SelectionRangeResponse,
  SetAccountPasswordRequest,
  SetAccountPasswordResponse,
  SheetFootprint,
  SheetSummary,
  UpdateBoardRequest,
  UpdateBoardResponse,
  UpdateImagePropertiesRequest,
  UpdateImagePropertiesResponse,
  UpdateMemberRoleRequest,
  UpdateMemberRoleResponse,
  UpdateSheetRequest,
  UpdateSheetResponse,
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
    request<InviteResponse>(`/groups/${groupId}/invite`, post(body)),
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
    request<ListBoardsResponse>(`/groups/${groupId}/boards`),
  createBoard: (groupId: string, body: CreateBoardRequest) =>
    request<CreateBoardResponse>(`/groups/${groupId}/boards`, post(body)),
  getBoard: (boardId: string) =>
    request<GetBoardResponse>(`/boards/${boardId}`),
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
    claims: {
      label?: string;
      relation?: string;
      annotated?: boolean;
      /** Every match in these ranks, uncapped (at most 20,000 wide). */
      window?: { from: number; to: number };
    } = {},
  ) => {
    const params = new URLSearchParams({ sort, q });
    if (claims.window)
      params.set('window', `${claims.window.from}-${claims.window.to}`);
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
  /** The board's label terms nearest a picture, or nearest one region of it
   * when `region` is given (cropped and read on its own by the server). */
  labelSuggestions: (
    boardId: string,
    imageId: string,
    region?: Fraction,
    limit = 5,
  ) =>
    request<LabelSuggestionsResponse>(
      `/boards/${boardId}/label-suggestions?${new URLSearchParams({
        image: imageId,
        limit: String(limit),
        ...(region
          ? {
              fx: String(region.fx),
              fy: String(region.fy),
              fw: String(region.fw),
              fh: String(region.fh),
            }
          : {}),
      })}`,
    ),
  /** Copies pictures from another board onto `boardId`, originals and
   * properties, never claims; one already there is skipped. */
  copyImages: (boardId: string, body: CopyImagesRequest) =>
    request<CopyImagesResponse>(`/boards/${boardId}/images/copy`, post(body)),
  /** A zip of pictures' originals, for a plain link: the ids, or the
   * viewer's stored selection when there are too many for a URL. */
  downloadUrl: (boardId: string, which: readonly string[] | 'selection') =>
    `${SERVER_ORIGIN}/boards/${boardId}/images/download?${
      which === 'selection'
        ? 'selection=1'
        : new URLSearchParams({ ids: which.join(',') })
    }`,
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
  /** Every connection meaning `relation` (aliases too) across the board's
   * sheets, and the pictures it joins: the web of one relation, whole. */
  relationWeb: (boardId: string, relation: string) =>
    request<GetNeighbourhoodResponse>(
      `/boards/${boardId}/relation-web?${new URLSearchParams({ relation })}`,
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
  /** CONTEXT.md "File metadata": what the file is and all it carries. */
  imageMetadata: (imageId: string) =>
    request<ImageMetadata>(`/images/${imageId}/metadata`),
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
    request<ListSheetsResponse>(
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
    request<GetSheetResponse>(`/sheets/${sheetId}`),
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
  // CONTEXT.md "Report": what a scope's claims say (server reports/).
  getSheetReport: (sheetId: string, opts: { ids?: string[] } = {}) =>
    request<ReportData>(
      `/sheets/${sheetId}/report${opts.ids ? `?${new URLSearchParams({ ids: opts.ids.join(',') })}` : ''}`,
    ),
  getBoardReport: (
    boardId: string,
    opts: { relation?: string; from?: string; to?: string } = {},
  ) => {
    const q = new URLSearchParams();
    if (opts.relation) q.set('relation', opts.relation);
    if (opts.from && opts.to) {
      q.set('from', opts.from);
      q.set('to', opts.to);
    }
    const qs = q.toString();
    return request<ReportData>(
      `/boards/${boardId}/report${qs ? `?${qs}` : ''}`,
    );
  },
  // CONTEXT.md "Kept report", "Published report" (server reports/kept.ts).
  keepReport: (boardId: string, body: { scope: ReportScope; title?: string }) =>
    request<ReportData>(`/boards/${boardId}/reports`, post(body)),
  listReports: (boardId: string) =>
    request<ListReportsResponse>(`/boards/${boardId}/reports`),
  getReport: (reportId: string) => request<ReportData>(`/reports/${reportId}`),
  reportChanges: (reportId: string) =>
    request<ReportChanges & { now: string }>(`/reports/${reportId}/changes`),
  /** Which of these SHA-256s the board holds as pictures: a report being
   * imported names its pictures by them (report/import.ts). */
  imagesBySha256: (boardId: string, hashes: string[]) =>
    request<{ images: { id: string; sha256: string; name: string }[] }>(
      `/boards/${boardId}/images/by-sha256`,
      post({ hashes }),
    ),
  /** A kept report's evidence: its data in every format, the originals and
   * SHA256SUMS, as one zip (server reports/bundle.ts). */
  reportBundleUrl: (reportId: string) =>
    `${SERVER_ORIGIN}/reports/${reportId}/bundle`,
  deleteReport: (reportId: string) =>
    request<{ ok: true }>(`/reports/${reportId}`, { method: 'DELETE' }),
  /** `days: null` makes a link with no end. */
  publishReport: (reportId: string, days: number | null) =>
    request<{ token: string; expiresAt: string | null }>(
      `/reports/${reportId}/link`,
      post({ days }),
    ),
  revokeReportLink: (reportId: string) =>
    request<{ ok: true }>(`/reports/${reportId}/link`, { method: 'DELETE' }),
  publishedReport: (token: string) =>
    request<ReportData>(`/published/${encodeURIComponent(token)}`),
  publishedImageUrl: (token: string, imageId: string) =>
    `${SERVER_ORIGIN}/published/${encodeURIComponent(token)}/images/${imageId}`,
  getStats: () => request<GetStatsResponse>('/stats'),

  // -- the site's operator (Settings › Accounts) -------------------------
  /** True for an operator; the server answers 403 for anyone else. */
  isOperator: async (): Promise<boolean> => {
    try {
      await request<OperatorResponse>('/operator');
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) return false;
      throw err;
    }
  },
  listAccounts: () => request<ListAccountsResponse>('/operator/accounts'),
  setAccountPassword: (accountId: string, body: SetAccountPasswordRequest) =>
    request<SetAccountPasswordResponse>(
      `/operator/accounts/${accountId}/password`,
      post(body),
    ),
};
