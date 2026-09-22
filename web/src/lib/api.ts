// The one place web spells an HTTP request. Every function here returns one
// of shared/src/api.ts's response types, so a payload shape is never guessed
// twice. `credentials: 'include'` on every call — the session lives in a
// cookie (docs/design.md "web/").

import type {
  AcceptInvitationResponse,
  AllowlistRequest,
  AllowlistResponse,
  CreateBoardRequest,
  CreateBoardResponse,
  CreateGroupRequest,
  CreateGroupResponse,
  CreateSheetRequest,
  CreateSheetResponse,
  GetBoardResponse,
  GetImageResponse,
  GetSheetElementsResponse,
  GetSheetForeignResponse,
  GetSheetResponse,
  GetSheetRowsResponse,
  GetStatsResponse,
  InviteRequest,
  InviteResponse,
  ListBoardImagesResponse,
  ListBoardsResponse,
  ListGroupsResponse,
  ListMembersResponse,
  ListSheetsResponse,
  UpdateBoardRequest,
  UpdateBoardResponse,
  UpdateImagePropertiesRequest,
  UpdateImagePropertiesResponse,
  UploadImagesResponse,
} from '@digsite/shared/api';

export const SERVER_ORIGIN: string =
  (import.meta.env.VITE_SERVER_ORIGIN as string | undefined) ??
  'http://localhost:8800';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly reason: string,
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
    try {
      const body = (await res.json()) as { reason?: string };
      if (body.reason) reason = body.reason;
    } catch {
      // no JSON body; keep statusText
    }
    throw new ApiError(res.status, reason);
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

export const api = {
  // -- groups --------------------------------------------------------------
  createGroup: (body: CreateGroupRequest) =>
    request<CreateGroupResponse>('/groups', post(body)),
  listGroups: () => request<ListGroupsResponse>('/groups'),
  invite: (groupId: string, body: InviteRequest) =>
    request<InviteResponse>(`/groups/${groupId}/invite`, post(body)),
  acceptInvitation: (invitationId: string) =>
    request<AcceptInvitationResponse>(`/invitations/${invitationId}/accept`, {
      method: 'POST',
    }),
  leaveGroup: (groupId: string) =>
    request<void>(`/groups/${groupId}/leave`, { method: 'POST' }),
  removeMember: (groupId: string, userId: string) =>
    request<void>(`/groups/${groupId}/members/${userId}`, {
      method: 'DELETE',
    }),
  listMembers: (groupId: string) =>
    request<ListMembersResponse>(`/groups/${groupId}/members`),

  // -- boards ----------------------------------------------------------------
  listBoards: (groupId: string) =>
    request<ListBoardsResponse>(`/groups/${groupId}/boards`),
  createBoard: (groupId: string, body: CreateBoardRequest) =>
    request<CreateBoardResponse>(`/groups/${groupId}/boards`, post(body)),
  getBoard: (boardId: string) =>
    request<GetBoardResponse>(`/boards/${boardId}`),
  updateBoard: (boardId: string, body: UpdateBoardRequest) =>
    request<UpdateBoardResponse>(`/boards/${boardId}`, patch(body)),
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
  getImage: (imageId: string) =>
    request<GetImageResponse>(`/images/${imageId}`),
  originalUrl: (imageId: string) =>
    `${SERVER_ORIGIN}/images/${imageId}/original`,
  updateImageProperties: (
    imageId: string,
    body: UpdateImagePropertiesRequest,
  ) =>
    request<UpdateImagePropertiesResponse>(`/images/${imageId}`, patch(body)),
  tileUrl: (boardId: string, sortId: string, z: number, x: number, y: number) =>
    `${SERVER_ORIGIN}/boards/${boardId}/tiles/${sortId}/${z}/${x}/${y}.png`,

  // -- sheets ------------------------------------------------------------
  listSheets: (boardId: string) =>
    request<ListSheetsResponse>(`/boards/${boardId}/sheets`),
  createSheet: (boardId: string, body: CreateSheetRequest) =>
    request<CreateSheetResponse>(`/boards/${boardId}/sheets`, post(body)),
  getSheet: (sheetId: string) =>
    request<GetSheetResponse>(`/sheets/${sheetId}`),
  getSheetElements: (sheetId: string) =>
    request<GetSheetElementsResponse>(`/sheets/${sheetId}/elements`),
  getSheetForeign: (sheetId: string) =>
    request<GetSheetForeignResponse>(`/sheets/${sheetId}/foreign`),
  getSheetRows: (sheetId: string) =>
    request<GetSheetRowsResponse>(`/sheets/${sheetId}/rows`),
  getStats: () => request<GetStatsResponse>('/stats'),
};
