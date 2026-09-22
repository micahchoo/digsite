// The socket (docs/phases/2-sheet.md section 3, CONTEXT.md "Snapshot"):
// join, the scene in (a remote 'joined'/'scene' payload reconciled onto the
// canvas through `CanvasHandle#applyRemote`) and out (our own changes,
// debounced and de-duplicated by `sync.ts#signature`), presence pointers and
// the peer roster. Moved out of Sheet.tsx so that file is composition only
// (docs/phases/2-sheet.md section 7). Talks to the canvas only through
// `CanvasHandle` — no `@excalidraw` import, per
// ../../.claude/rules/sheet-canvas-seam.md.
import type { PeersPayload, PointerBroadcastPayload } from '@digsite/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type Socket, io } from 'socket.io-client';
import { SERVER_ORIGIN } from '../lib/api.ts';
import type { CanvasHandle, SceneElement } from './canvas/types.ts';
import { canSendPointer } from './presence.ts';
import { isSyncable, signature } from './sync.ts';

export interface Peer {
  id: string;
  name: string;
}

export interface RoomStatus {
  emits: number;
  recvs: number;
  lastEmitAt: number | null;
  lastRecvAt: number | null;
  peers: Peer[];
}

const EMIT_DEBOUNCE_MS = 100;

export interface RoomDeps {
  sheetId: string;
  getHandle: () => CanvasHandle | null;
  /** Every image id the socket's 'joined' payload references, beyond what
   * the caller's own `GET /sheets/:id` already knew (an image another peer
   * added between that fetch and this join) — loaded the same way. */
  loadImages: (imageIds: string[]) => void | Promise<void>;
  /** Fired after 'joined' or a remote 'scene' delta lands on the canvas —
   * the caller re-reads `getHandle()!.elements()` for its own state (the
   * overlay, the dangling list) rather than room.ts keeping a second copy. */
  onRemoteChange: () => void;
}

export interface Room {
  denied: string | null;
  peers: Peer[];
  peerPointers: PointerBroadcastPayload[];
  getStatus: () => RoomStatus;
  /** Debounced 100ms and skipped when nothing syncable actually changed
   * (`sync.ts#signature`) — the same discipline the pre-split Sheet.tsx
   * had. */
  sendScene: (elements: SceneElement[]) => void;
  /** Throttled client-side to `presence.ts#POINTER_RATE_PER_S`, on top of
   * the server's own per-socket rate limit. */
  sendPointer: (x: number, y: number, selectedIds: string[]) => void;
}

export function useRoom(deps: RoomDeps): Room {
  const { sheetId, getHandle, loadImages, onRemoteChange } = deps;

  const socketRef = useRef<Socket | null>(null);
  const lastEmittedSig = useRef('');
  const emitTimer = useRef<number | null>(null);
  const lastPointerSentRef = useRef<number | null>(null);
  const statusRef = useRef<RoomStatus>({
    emits: 0,
    recvs: 0,
    lastEmitAt: null,
    lastRecvAt: null,
    peers: [],
  });
  const [, bumpTick] = useState(0);
  const rerender = useCallback(() => bumpTick((n) => n + 1), []);

  const [denied, setDenied] = useState<string | null>(null);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [peerPointers, setPeerPointers] = useState<PointerBroadcastPayload[]>(
    [],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: `getHandle`/`loadImages`/`onRemoteChange`/`rerender` are stable identities (Sheet.tsx's own useCallback with []/[tools] deps, and `rerender` above with []) — re-running this effect on their identity would tear down and rejoin the room for no reason; `sheetId` is the only dependency that should ever reopen the socket.
  useEffect(() => {
    if (!sheetId) return;
    let cancelled = false;
    const socket = io(SERVER_ORIGIN, { withCredentials: true });
    socketRef.current = socket;

    socket.on('join-denied', ({ reason }: { reason: string }) => {
      if (cancelled) return;
      setDenied(reason);
      socket.disconnect();
    });

    socket.on(
      'joined',
      async ({
        elements,
        peers: joinedPeers,
      }: { elements: unknown[]; peers: string[] }) => {
        if (cancelled) return;
        const imageIds = new Set<string>();
        for (const el of elements as {
          customData?: { kind?: string; imageId?: string };
        }[]) {
          if (el.customData?.kind === 'image' && el.customData.imageId) {
            imageIds.add(el.customData.imageId);
          }
        }
        await loadImages([...imageIds]);
        if (cancelled) return;
        getHandle()?.applyRemote(elements);
        lastEmittedSig.current = signature(
          (getHandle()?.elements() ?? []).filter(isSyncable),
        );
        // 'joined' carries ids only (the stub, and the real room.ts, send
        // names on the very next 'peers' broadcast — the same tick this
        // socket just joined into) — a peer briefly shows by id until then.
        const joinedAsPeers = joinedPeers.map((id) => ({ id, name: id }));
        setPeers(joinedAsPeers);
        statusRef.current = { ...statusRef.current, peers: joinedAsPeers };
        onRemoteChange();
        rerender();
      },
    );

    // `peers` carries {id,name} objects (PeersPayload, phase 2 section 3)
    // — the stub sends them too; `users` (ids only) is read as a fallback
    // so this still degrades against a peers payload with no names. Also
    // prunes peerPointers for anyone who just left, so a departed peer's
    // cursor never lingers.
    socket.on('peers', (payload: PeersPayload) => {
      if (cancelled) return;
      const list = payload.peers?.length
        ? payload.peers
        : payload.users.map((u) => ({ id: u, name: u }));
      const asPeers = list.map((p) => ({ id: p.id, name: p.name || p.id }));
      setPeers(asPeers);
      statusRef.current = { ...statusRef.current, peers: asPeers };
      const live = new Set(list.map((p) => p.id));
      setPeerPointers((prev) => prev.filter((p) => live.has(p.user)));
      rerender();
    });

    // A peer's pointer (docs/phases/2-sheet.md section 3): never persisted,
    // replaced by user id on every event.
    socket.on('pointer', (payload: PointerBroadcastPayload) => {
      if (cancelled) return;
      setPeerPointers((prev) => [
        ...prev.filter((p) => p.user !== payload.user),
        payload,
      ]);
    });

    socket.on('scene', ({ elements: remote }: { elements: unknown[] }) => {
      if (cancelled) return;
      getHandle()?.applyRemote(remote);
      lastEmittedSig.current = signature(
        (getHandle()?.elements() ?? []).filter(isSyncable),
      );
      statusRef.current = {
        ...statusRef.current,
        lastRecvAt: Date.now(),
        recvs: statusRef.current.recvs + 1,
      };
      onRemoteChange();
      rerender();
    });

    socket.emit('join', { sheetId });

    return () => {
      cancelled = true;
      socket.disconnect();
      socketRef.current = null;
    };
  }, [sheetId]);

  const sendScene = useCallback(
    (elements: SceneElement[]) => {
      const syncable = elements.filter(isSyncable);
      const sig = signature(syncable);
      if (sig === lastEmittedSig.current) return;
      lastEmittedSig.current = sig;
      if (emitTimer.current !== null) window.clearTimeout(emitTimer.current);
      emitTimer.current = window.setTimeout(() => {
        socketRef.current?.emit('scene', { elements: syncable });
        statusRef.current = {
          ...statusRef.current,
          lastEmitAt: Date.now(),
          emits: statusRef.current.emits + 1,
        };
        rerender();
      }, EMIT_DEBOUNCE_MS);
    },
    [rerender],
  );

  const sendPointer = useCallback(
    (x: number, y: number, selectedIds: string[]) => {
      const socket = socketRef.current;
      if (!socket) return;
      const now = Date.now();
      if (!canSendPointer(now, lastPointerSentRef.current)) return;
      lastPointerSentRef.current = now;
      socket.emit('pointer', { x, y, selectedIds });
    },
    [],
  );

  return {
    denied,
    peers,
    peerPointers,
    getStatus: () => ({ ...statusRef.current }),
    sendScene,
    sendPointer,
  };
}
