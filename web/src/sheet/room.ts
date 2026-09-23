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
import { RemoteSceneBuffer } from './remote-scenes.ts';
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
    const loadedImageIds = new Set<string>();
    const pendingScenes = new RemoteSceneBuffer();
    let processingScenes = false;
    let pendingSceneCount = 0;
    let pendingLastRecvAt: number | null = null;
    let pendingJoinedPeers: string[] | null = null;
    let receivedPeerRoster = false;

    const drainRemoteScenes = () => {
      if (processingScenes || cancelled) return;
      processingScenes = true;
      void (async () => {
        let elements = pendingScenes.take();
        while (elements && !cancelled) {
          const imageIds = new Set<string>();
          for (const el of elements as {
            customData?: { kind?: string; imageId?: string };
          }[]) {
            if (
              el.customData?.kind === 'image' &&
              el.customData.imageId &&
              !loadedImageIds.has(el.customData.imageId)
            ) {
              imageIds.add(el.customData.imageId);
            }
          }
          if (imageIds.size) {
            try {
              await loadImages([...imageIds]);
              for (const imageId of imageIds) loadedImageIds.add(imageId);
            } catch (err) {
              console.error('remote sheet image load failed', err);
            }
          }
          if (cancelled) return;

          // Fold any scenes received during the asset load into this one.
          // Recheck assets after merging because the newer scene may add an
          // image that was not in the scene whose load just completed.
          const later = pendingScenes.take();
          if (later) {
            pendingScenes.enqueue(elements);
            pendingScenes.enqueue(later);
            elements = pendingScenes.take();
            continue;
          }

          getHandle()?.applyRemote(elements);
          lastEmittedSig.current = signature(
            (getHandle()?.elements() ?? []).filter(isSyncable),
          );

          if (pendingJoinedPeers !== null) {
            if (!receivedPeerRoster) {
              const joinedAsPeers = pendingJoinedPeers.map((id) => ({
                id,
                name: '',
              }));
              setPeers(joinedAsPeers);
              statusRef.current = {
                ...statusRef.current,
                peers: joinedAsPeers,
              };
            }
            pendingJoinedPeers = null;
          }
          if (pendingSceneCount > 0) {
            statusRef.current = {
              ...statusRef.current,
              lastRecvAt: pendingLastRecvAt,
              recvs: statusRef.current.recvs + pendingSceneCount,
            };
            pendingSceneCount = 0;
            pendingLastRecvAt = null;
          }
          onRemoteChange();
          rerender();
          elements = pendingScenes.take();
        }
      })()
        .catch((err) => console.error('remote sheet scene failed', err))
        .finally(() => {
          processingScenes = false;
          if (pendingScenes.hasPending() && !cancelled) drainRemoteScenes();
        });
    };

    const queueRemoteScene = (
      elements: unknown[],
      opts: { joinedPeers?: string[]; scene?: boolean } = {},
    ) => {
      pendingScenes.enqueue(elements);
      if (opts.joinedPeers) pendingJoinedPeers = opts.joinedPeers;
      if (opts.scene) {
        pendingSceneCount++;
        pendingLastRecvAt = Date.now();
      }
      drainRemoteScenes();
    };

    socket.on('join-denied', ({ reason }: { reason: string }) => {
      if (cancelled) return;
      setDenied(reason);
      socket.disconnect();
    });

    socket.on(
      'joined',
      ({
        elements,
        peers: joinedPeers,
      }: { elements: unknown[]; peers: string[] }) => {
        if (cancelled) return;
        // joined carries ids only; the named peers event can arrive while
        // image files load, so its roster must win over these blank names.
        queueRemoteScene(elements, { joinedPeers });
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
      receivedPeerRoster = true;
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
      queueRemoteScene(remote, { scene: true });
    });

    socket.emit('join', { sheetId });

    return () => {
      cancelled = true;
      pendingScenes.take();
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
