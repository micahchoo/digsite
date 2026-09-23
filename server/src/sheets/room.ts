// The sheet room: Socket.IO on the same port as the HTTP server. `join`
// calls `sheetForEditing` — the same access function the HTTP routes call,
// per .claude/rules/access-one-function-per-intent.md ("the socket gate is
// the same function"). `scene` is the client's full syncable set; it is
// relayed, then a snapshot is debounced 1,500ms after the last one.
//
// Rooms span API processes (roadmap item 1): the Postgres adapter relays
// every room broadcast to the other processes, and presence is read from
// every process's sockets (`fetchSockets`), not from this one's alone.
// Snapshots need nothing more: saveSnapshotAndProject locks the sheet row
// and merges by version, so two processes saving one sheet merge.
import type { Server as HttpServer } from 'node:http';
import type {
  JoinDeniedPayload,
  JoinPayload,
  JoinedPayload,
  LimitedPayload,
  PeersPayload,
  PointerBroadcastPayload,
  PointerPayload,
  SceneClientPayload,
  SceneServerPayload,
} from '@digsite/shared/api';
import { createAdapter } from '@socket.io/postgres-adapter';
import { fromNodeHeaders } from 'better-auth/node';
import { Pool } from 'pg';
import { type Socket, Server as SocketIOServer } from 'socket.io';
import { AccessDenied, sheetForEditing } from '../access/index.ts';
import { auth } from '../auth.ts';
import { env } from '../env.ts';
import { checkLimit } from '../limits.ts';
import { getSnapshotElements, saveSnapshotAndProject } from './snapshot.ts';
import { verifyStamps } from './stamps.ts';

const DEBOUNCE_MS = 1500;
// One for the adapter's LISTEN, two for its notifies and attachment reads.
const ADAPTER_CONNECTIONS = 3;
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

// This process's sockets per sheet, for the metrics gauge only: sheetId ->
// socketId -> {id, name}. Presence sent to clients is read from every
// process (peersPayloadFor), because a room's peers may be connected to
// another API process.
type Peer = { id: string; name: string };
const peers = new Map<string, Map<string, Peer>>();

/** Everyone in the sheet's room, on every API process. Names come from the
 * session at join time (socket.data), so this needs no query. `leaving` is
 * a socket still in the room while it disconnects. */
async function peersPayloadFor(
  io: SocketIOServer,
  sheetId: string,
  leaving: string | null = null,
): Promise<PeersPayload> {
  const sockets = await io.in(sheetId).fetchSockets();
  const list: Peer[] = sockets
    .filter((s) => s.id !== leaving && s.data.userId)
    .map((s) => ({ id: s.data.userId as string, name: s.data.userName ?? '' }));
  return { users: list.map((p) => p.id), peers: list };
}

/** metrics.ts's "socket rooms and peers" gauge (docs/phases/5-hardening.md
 * section 4) — the only reader of `peers` outside this file. */
export function roomCounts(): { rooms: number; peers: number } {
  let peerTotal = 0;
  for (const room of peers.values()) peerTotal += room.size;
  return { rooms: peers.size, peers: peerTotal };
}

const pending = new Map<
  string,
  { timer: ReturnType<typeof setTimeout>; latest: unknown[] }
>();

const roomServers = new Set<SocketIOServer>();

/** Publish an HTTP-authored scene change to the same `scene` channel used by
 * live edits. The snapshot is already committed when callers invoke this. */
export function broadcastSheetScene(
  sheetId: string,
  elements: unknown[],
  from: string,
): void {
  const out: SceneServerPayload = { elements, from };
  // One server's emit reaches every process through the adapter; emitting
  // from each server this process holds would deliver it once per server.
  const io = roomServers.values().next().value;
  if (!io) return;
  io.to(sheetId).emit('scene', out);
  roomStats.broadcasts++;
}

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
  // Its own small pool, not the app's: the adapter holds one connection for
  // LISTEN for as long as the server lives, and a pool of ten shared with
  // every request ran dry after ten servers in the test run. Closed with
  // the HTTP server, so a server never leaves a connection behind.
  const adapterPool = new Pool({
    connectionString: env.DATABASE_URL,
    max: ADAPTER_CONNECTIONS,
  });
  adapterPool.on('error', (err) => console.error('[room] adapter pool', err));
  io.adapter(createAdapter(adapterPool));
  roomServers.add(io);
  httpServer.once('close', () => {
    roomServers.delete(io);
    io.close();
    adapterPool.end().catch(() => {});
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

        // Phase 5 section 2 (docs/phases/5-hardening.md "Abuse limits"):
        // checked here, not in `io.on('connection', ...)` — the bucket is
        // per USER, and the user is only known once the session resolves.
        // A `limited` refusal drops the socket (same as `join-denied`),
        // rather than answering `429` — this is Socket.IO, no HTTP
        // response to carry a status on.
        const limit = checkLimit('socket-connect', session.user.id);
        if (!limit.allowed) {
          const limited: LimitedPayload = { reason: 'socket-connect' };
          socket.emit('limited', limited);
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
        const present = await peersPayloadFor(io, payload.sheetId);
        const joined: JoinedPayload = { elements, peers: present.users };
        socket.emit('joined', joined);

        io.to(payload.sheetId).emit('peers', present);
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

      // Phase 5 section 2: 30/s per user — a `limited` notice, and the
      // payload itself is dropped (no broadcast, no snapshot), same as an
      // over-rate pointer below is dropped silently. Unlike `pointer`'s
      // own ad hoc per-socket counter, this goes through the shared bucket
      // so it's the same limit `checkLimit('scene-emit', ...)` reports on
      // in a test and the one the client actually hits.
      const limit = checkLimit('scene-emit', userId);
      if (!limit.allowed) {
        const limited: LimitedPayload = { reason: 'scene-emit' };
        socket.emit('limited', limited);
        return;
      }

      roomStats.scenes++;
      roomStats.foreignInScene += countForeign(payload.elements);

      // Stamps are the server's word (sheets/stamps.ts): what peers see and
      // what the snapshot keeps name the sender for every stamp the server
      // has not already signed. The one door client stamps come in by.
      const elements = verifyStamps(payload.elements, sheetId, {
        id: userId,
        name: (socket.data.userName as string) || '',
      });
      const out: SceneServerPayload = { elements, from: userId };
      socket.to(sheetId).emit('scene', out);
      roomStats.broadcasts++;

      scheduleSnapshot(sheetId, elements);
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
      peersPayloadFor(io, sheetId, socket.id)
        .then((present) => io.to(sheetId).emit('peers', present))
        .catch((err) => console.error('peers failed', sheetId, err));
    });
  });

  return io;
}
