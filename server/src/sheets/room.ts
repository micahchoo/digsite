// The sheet room: Socket.IO on the same port as the HTTP server. `join`
// calls `sheetForEditing` — the same access function the HTTP routes call,
// per .claude/rules/access-one-function-per-intent.md ("the socket gate is
// the same function"). `scene` is the client's full syncable set; it is
// relayed, then a snapshot is debounced 1,500ms after the last one.
import type { Server as HttpServer } from 'node:http';
import type {
  JoinDeniedPayload,
  JoinPayload,
  JoinedPayload,
  PeersPayload,
  PointerBroadcastPayload,
  PointerPayload,
  SceneClientPayload,
  SceneServerPayload,
} from '@digsite/shared/api';
import { fromNodeHeaders } from 'better-auth/node';
import { type Socket, Server as SocketIOServer } from 'socket.io';
import { AccessDenied, sheetForEditing } from '../access/index.ts';
import { auth } from '../auth.ts';
import { env } from '../env.ts';
import { getSnapshotElements, saveSnapshotAndProject } from './snapshot.ts';

const DEBOUNCE_MS = 1500;
// Presence (docs/phases/2-sheet.md section 3): server-enforced, not a hint
// to the client — a socket past this in the current second has its pointer
// events dropped, not queued.
const POINTER_RATE_PER_S = 20;

export const roomStats = {
  scenes: 0,
  broadcasts: 0,
  snapshots: 0,
  lastProjectionMs: 0,
  foreignInScene: 0, // must stay 0 — see .claude/rules/foreign-never-in-scene.md
};

function countForeign(elements: unknown[]): number {
  return elements.filter((e) => {
    const customData = (e as { customData?: unknown } | null)?.customData;
    return (
      typeof customData === 'object' &&
      customData !== null &&
      'foreign' in customData
    );
  }).length;
}

// sheetId -> socketId -> {id, name}. Names come from Better Auth's `user`
// table by way of the session (`session.user.name`) at join time — no
// extra query, since getSession already reads it.
type Peer = { id: string; name: string };
const peers = new Map<string, Map<string, Peer>>();
function peerList(sheetId: string): Peer[] {
  return Array.from(peers.get(sheetId)?.values() ?? []);
}
function peersPayloadFor(sheetId: string): PeersPayload {
  const list = peerList(sheetId);
  return { users: list.map((p) => p.id), peers: list };
}

const pending = new Map<
  string,
  { timer: ReturnType<typeof setTimeout>; latest: unknown[] }
>();

function scheduleSnapshot(sheetId: string, elements: unknown[]): void {
  const entry = pending.get(sheetId);
  if (entry) clearTimeout(entry.timer);
  const timer = setTimeout(() => {
    pending.delete(sheetId);
    saveSnapshotAndProject(sheetId, elements)
      .then((r) => {
        roomStats.snapshots++;
        roomStats.lastProjectionMs = r.projectionMs;
      })
      .catch((err) => console.error('snapshot failed', sheetId, err));
  }, DEBOUNCE_MS);
  pending.set(sheetId, { timer, latest: elements });
}

export function mountSheetRoom(httpServer: HttpServer): SocketIOServer {
  const io = new SocketIOServer(httpServer, {
    cors: { origin: env.WEB_ORIGIN, credentials: true },
  });

  io.on('connection', (socket: Socket) => {
    socket.on('join', async (payload: JoinPayload) => {
      try {
        const session = await auth.api.getSession({
          // biome-ignore lint/suspicious/noExplicitAny: socket.handshake.headers is Record<string,string|string[]>, close enough to node's IncomingHttpHeaders for fromNodeHeaders
          headers: fromNodeHeaders(socket.handshake.headers as any),
        });
        if (!session) {
          const denied: JoinDeniedPayload = { reason: 'no session' };
          socket.emit('join-denied', denied);
          socket.disconnect(true);
          return;
        }

        await sheetForEditing(session.user.id, payload.sheetId);
        socket.data.sheetId = payload.sheetId;
        socket.data.userId = session.user.id;
        socket.data.userName = session.user.name;
        await socket.join(payload.sheetId);

        if (!peers.has(payload.sheetId)) peers.set(payload.sheetId, new Map());
        peers
          .get(payload.sheetId)
          ?.set(socket.id, { id: session.user.id, name: session.user.name });

        const elements = await getSnapshotElements(payload.sheetId);
        const joined: JoinedPayload = {
          elements,
          peers: peerList(payload.sheetId).map((p) => p.id),
        };
        socket.emit('joined', joined);

        io.to(payload.sheetId).emit('peers', peersPayloadFor(payload.sheetId));
      } catch (err) {
        const reason = err instanceof AccessDenied ? err.reason : 'error';
        const denied: JoinDeniedPayload = { reason };
        socket.emit('join-denied', denied);
        socket.disconnect(true);
      }
    });

    socket.on('scene', (payload: SceneClientPayload) => {
      const sheetId = socket.data.sheetId as string | undefined;
      const userId = socket.data.userId as string | undefined;
      if (!sheetId || !userId) return;

      roomStats.scenes++;
      roomStats.foreignInScene += countForeign(payload.elements);

      const out: SceneServerPayload = {
        elements: payload.elements,
        from: userId,
      };
      socket.to(sheetId).emit('scene', out);
      roomStats.broadcasts++;

      scheduleSnapshot(sheetId, payload.elements);
    });

    // Presence (docs/phases/2-sheet.md section 3): never persisted, never
    // debounced into a snapshot — a pointer is relayed and forgotten. Rate
    // limited per socket, server-side, so one fast/broken client can't
    // flood the room; extras are dropped, not queued or coalesced.
    socket.on('pointer', (payload: PointerPayload) => {
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

      const out: PointerBroadcastPayload = {
        x: payload.x,
        y: payload.y,
        selectedIds: payload.selectedIds,
        user: userId,
        name: (socket.data.userName as string) || '',
      };
      socket.to(sheetId).emit('pointer', out);
    });

    socket.on('disconnecting', () => {
      const sheetId = socket.data.sheetId as string | undefined;
      if (!sheetId) return;
      peers.get(sheetId)?.delete(socket.id);
      io.to(sheetId).emit('peers', peersPayloadFor(sheetId));
    });
  });

  return io;
}
