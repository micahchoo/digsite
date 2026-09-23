// Presence on a board (CONTEXT.md "Presence"): who else is looking at the
// board, the cell each one's pointer is on and the images each has
// selected, so the map can outline them in that person's colour. It rides
// the sheet rooms' Socket.IO server and Postgres adapter, so viewers on
// different API processes see each other.
//
// A room per board, `board:<id>`, joined with `board-join`, gated by the
// same access function as the board page (boardForViewing). Two kinds of
// `presence` message go out:
//   - full: the whole list, on a join and a leave, read from every
//     process (fetchSockets);
//   - a change: only the one viewer who moved. A full list per pointer
//     move would be a cross-process fetch at 5 a second a viewer.
// Entries are keyed by socket, not by user: two tabs are two viewers.
import type {
  BoardJoinPayload,
  BoardPresencePayload,
  PresenceUpdatePayload,
  PresenceViewer,
} from '@digsite/shared/api';
import { fromNodeHeaders } from 'better-auth/node';
import type { Socket, Server as SocketIOServer } from 'socket.io';
import { AccessDenied, boardForViewing } from '../access/index.ts';
import { auth } from '../auth.ts';

const ROOM = (boardId: string) => `board:${boardId}`;
/** Changes a viewer may send a second; more are dropped, not queued. */
export const PRESENCE_RATE_PER_S = 5;
/** Selected images carried per viewer; a bigger selection is cut. */
export const PRESENCE_SELECTED_MAX = 200;

/** A colour per person, the same on every screen and every visit. */
export function colourOf(userId: string): string {
  let h = 0;
  for (const c of userId) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 70% 45%)`;
}

function viewerOf(socket: {
  id: string;
  data: Record<string, unknown>;
}): PresenceViewer {
  const d = socket.data;
  return {
    key: socket.id,
    id: d.userId as string,
    name: (d.userName as string) ?? '',
    colour: colourOf(d.userId as string),
    hover: (d.hover as string | null) ?? null,
    selected: (d.selected as string[]) ?? [],
  };
}

async function everyone(
  io: SocketIOServer,
  boardId: string,
  leaving: string | null,
): Promise<BoardPresencePayload> {
  const sockets = await io.in(ROOM(boardId)).fetchSockets();
  return {
    full: true,
    viewers: sockets
      .filter((s) => s.id !== leaving && s.data.userId)
      .map((s) => viewerOf(s)),
  };
}

async function leave(io: SocketIOServer, socket: Socket): Promise<void> {
  const boardId = socket.data.boardId as string | undefined;
  if (!boardId) return;
  socket.data.boardId = undefined;
  await socket.leave(ROOM(boardId));
  io.to(ROOM(boardId)).emit('presence', await everyone(io, boardId, socket.id));
}

export function attachBoardPresence(io: SocketIOServer): void {
  io.on('connection', (socket: Socket) => {
    socket.on('board-join', async (payload: BoardJoinPayload) => {
      try {
        const session = await auth.api.getSession({
          // biome-ignore lint/suspicious/noExplicitAny: handshake headers are close enough to IncomingHttpHeaders for fromNodeHeaders
          headers: fromNodeHeaders(socket.handshake.headers as any),
        });
        if (!session) throw new AccessDenied('no session');
        await boardForViewing(session.user.id, payload.boardId);
        await leave(io, socket);
        socket.data.boardId = payload.boardId;
        socket.data.userId = session.user.id;
        socket.data.userName = session.user.name;
        socket.data.hover = null;
        socket.data.selected = [];
        await socket.join(ROOM(payload.boardId));
        io.to(ROOM(payload.boardId)).emit(
          'presence',
          await everyone(io, payload.boardId, null),
        );
      } catch (err) {
        const reason = err instanceof AccessDenied ? err.reason : 'error';
        socket.emit('board-join-denied', { reason });
      }
    });

    socket.on('board-presence', (payload: PresenceUpdatePayload) => {
      const boardId = socket.data.boardId as string | undefined;
      if (!boardId) return;
      const now = Date.now();
      if (now - ((socket.data.presenceWindow as number) || 0) >= 1000) {
        socket.data.presenceWindow = now;
        socket.data.presenceCount = 0;
      }
      socket.data.presenceCount =
        ((socket.data.presenceCount as number) || 0) + 1;
      if ((socket.data.presenceCount as number) > PRESENCE_RATE_PER_S) return;
      socket.data.hover =
        typeof payload?.hover === 'string' ? payload.hover : null;
      socket.data.selected = Array.isArray(payload?.selected)
        ? payload.selected
            .filter((id): id is string => typeof id === 'string')
            .slice(0, PRESENCE_SELECTED_MAX)
        : [];
      const change: BoardPresencePayload = {
        full: false,
        viewers: [viewerOf(socket)],
      };
      socket.to(ROOM(boardId)).emit('presence', change);
    });

    socket.on('board-leave', () => {
      leave(io, socket).catch(() => {});
    });
    socket.on('disconnecting', () => {
      const boardId = socket.data.boardId as string | undefined;
      if (!boardId) return;
      everyone(io, boardId, socket.id)
        .then((payload) => io.to(ROOM(boardId)).emit('presence', payload))
        .catch(() => {});
    });
  });
}
