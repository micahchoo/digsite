// The document (docs/design.md "web/" § "The sheet page"). Mounts one
// Excalidraw with the snapshot delivered by the socket's `joined` payload,
// loads every image file, and wires window.__digsite (tools.ts) plus the
// foreign overlay (overlay/) — which never touches this scene, per
// ../.claude/rules/foreign-never-in-scene.md.
import {
  type Fraction,
  clampFraction,
  dataOf,
  fileId,
  fromFraction,
  toFraction,
} from '@digsite/shared';
import {
  CaptureUpdateAction,
  Excalidraw,
  newElementWith,
  reconcileElements,
  restoreElements,
} from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type {
  AppState,
  ExcalidrawImperativeAPI,
} from '@excalidraw/excalidraw/types';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { type Socket, io } from 'socket.io-client';
import { SERVER_ORIGIN, api } from '../lib/api.ts';
import { useSession } from '../lib/auth.ts';
import { Inspector } from './Inspector.tsx';
import { Overlay } from './overlay/Overlay.tsx';
import {
  type ForeignShape,
  type Rect,
  type Viewport,
  foreignShapes,
} from './overlay/screen.ts';
import { useForeign } from './overlay/useForeign.ts';
import { isSyncable, signature } from './sync.ts';
import { type SyncStatus, createTools } from './tools.ts';

declare global {
  interface Window {
    __digsiteSheetDebug?: { getAppState: () => AppState | null };
  }
}

function rectOf(el: {
  x: number;
  y: number;
  width: number;
  height: number;
}): Rect {
  return { x: el.x, y: el.y, width: el.width, height: el.height };
}

function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export function Sheet() {
  const { id } = useParams<{ id: string }>();
  const sheetId = id ?? '';
  const { data: session } = useSession();

  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const loadedImages = useRef<Set<string>>(new Set());
  const lastEmittedSig = useRef('');
  const emitTimer = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const statsRef = useRef<SyncStatus>({
    emits: 0,
    recvs: 0,
    lastEmitAt: null,
    lastRecvAt: null,
    peers: [],
  });
  const selectedForeignRef = useRef<string | null>(null);
  const foreignShapesRef = useRef<ForeignShape[]>([]);
  const toolsRef = useRef<ReturnType<typeof createTools> | null>(null);

  const [sheetInfo, setSheetInfo] = useState<Awaited<
    ReturnType<typeof api.getSheet>
  > | null>(null);
  const [denied, setDenied] = useState<string | null>(null);
  const [peers, setPeers] = useState<string[]>([]);
  const [selectedForeignId, setSelectedForeignIdState] = useState<
    string | null
  >(null);
  const [sceneElements, setSceneElements] = useState<ExcalidrawElement[]>([]);
  const [viewport, setViewport] = useState<Viewport>({
    scrollX: 0,
    scrollY: 0,
    zoom: 1,
  });
  const [, bumpTick] = useState(0);
  const rerender = useCallback(() => bumpTick((n) => n + 1), []);

  const foreignRows = useForeign(sheetId);

  useEffect(() => {
    foreignShapesRef.current = foreignShapes(foreignRows, sceneElements);
    rerender();
  }, [foreignRows, sceneElements, rerender]);

  const applySelectedForeign = useCallback((sid: string | null) => {
    selectedForeignRef.current = sid;
    setSelectedForeignIdState(sid);
  }, []);

  // A stable ref callback: an inline arrow here gets a new identity every
  // render, and Excalidraw treats that as a new API consumer on each one —
  // observed as an infinite forceStoreRerender loop inside Excalidraw's own
  // store (Maximum update depth exceeded).
  const setApi = useCallback((instance: ExcalidrawImperativeAPI) => {
    apiRef.current = instance;
  }, []);

  if (!toolsRef.current) {
    toolsRef.current = createTools({
      getApi: () => apiRef.current,
      getForeignShapes: () => foreignShapesRef.current,
      getSelectedForeignId: () => selectedForeignRef.current,
      setSelectedForeign: applySelectedForeign,
      getSyncStatus: () => ({ ...statsRef.current }),
    });
  }
  const tools = toolsRef.current;

  useEffect(() => {
    window.__digsite = tools;
  }, [tools]);

  // A debug-only hook for e2e, NOT part of the fixed window.__digsite
  // contract (docs/design.md's Tools list has no raw-appState getter) —
  // same pattern as pages/Board.tsx's window.__digsiteBoard. Scenario 8
  // (.claude/rules/foreign-never-in-scene.md) asserts a pointer drag across
  // a foreign shape never reaches Excalidraw's own selection; that needs a
  // read of appState.selectedElementIds, which no product hook exposes.
  useEffect(() => {
    window.__digsiteSheetDebug = {
      getAppState: () => apiRef.current?.getAppState() ?? null,
    };
  }, []);

  const loadImages = useCallback(async (imageIds: string[]) => {
    const toLoad = imageIds.filter((id) => !loadedImages.current.has(id));
    if (!toLoad.length) return;
    const files = await Promise.all(
      toLoad.map(async (imageId) => {
        const res = await fetch(api.originalUrl(imageId), {
          credentials: 'include',
        });
        const blob = await res.blob();
        const dataURL = await blobToDataURL(blob);
        return {
          id: fileId(imageId),
          dataURL,
          mimeType: blob.type || 'image/png',
          created: Date.now(),
        };
      }),
    );
    // Mark loaded only once addFiles actually ran. Sheet.tsx calls
    // loadImages twice — eagerly right after GET /sheets/:id, and again
    // from the socket's 'joined' handler — and the eager call can resolve
    // before Excalidraw has mounted (apiRef.current still null). Marking
    // unconditionally there meant `?.addFiles` silently no-op'd and the
    // dedupe set stopped the 'joined' call from ever retrying, leaving
    // those images permanently missing from the scene.
    const liveApi = apiRef.current;
    if (!liveApi) return;
    // biome-ignore lint/suspicious/noExplicitAny: BinaryFileData's branded DataURL isn't worth hand-narrowing
    liveApi.addFiles(files as any);
    for (const imageId of toLoad) loadedImages.current.add(imageId);
  }, []);

  // -- connect: fetch sheet info, then join the room ------------------------
  useEffect(() => {
    if (!sheetId) return;
    let cancelled = false;
    let socket: Socket | null = null;

    void (async () => {
      const info = await api.getSheet(sheetId);
      if (cancelled) return;
      setSheetInfo(info);
      void loadImages(info.images.map((i) => i.id));

      socket = io(SERVER_ORIGIN, { withCredentials: true });
      socketRef.current = socket;

      socket.on('join-denied', ({ reason }: { reason: string }) => {
        setDenied(reason);
        socket?.disconnect();
      });

      socket.on(
        'joined',
        async ({
          elements,
          peers: joinedPeers,
        }: { elements: unknown[]; peers: string[] }) => {
          const restored = restoreElements(
            // biome-ignore lint/suspicious/noExplicitAny: restoreElements' input type is the server's raw JSON
            elements as any,
            null,
          ) as unknown as ExcalidrawElement[];
          const imageIds = new Set(info.images.map((i) => i.id));
          for (const el of restored) {
            const data = dataOf(el);
            if (data?.kind === 'image') imageIds.add(data.imageId);
          }
          await loadImages([...imageIds]);
          apiRef.current?.updateScene({
            elements: restored,
            captureUpdate: CaptureUpdateAction.NEVER,
          });
          lastEmittedSig.current = signature(restored.filter(isSyncable));
          setPeers(joinedPeers);
          statsRef.current = { ...statsRef.current, peers: joinedPeers };
          setSceneElements(restored);
          rerender();
        },
      );

      socket.on('peers', ({ users }: { users: string[] }) => {
        setPeers(users);
        statsRef.current = { ...statsRef.current, peers: users };
        rerender();
      });

      socket.on('scene', ({ elements: remote }: { elements: unknown[] }) => {
        const liveApi = apiRef.current;
        if (!liveApi) return;
        const local = liveApi.getSceneElementsIncludingDeleted();
        const reconciled = reconcileElements(
          local,
          // biome-ignore lint/suspicious/noExplicitAny: reconcileElements' remote arg is the server's raw JSON
          remote as any,
          liveApi.getAppState(),
        );
        liveApi.updateScene({
          elements: reconciled,
          captureUpdate: CaptureUpdateAction.NEVER,
        });
        const reconciledEls = reconciled as unknown as ExcalidrawElement[];
        lastEmittedSig.current = signature(reconciledEls.filter(isSyncable));
        statsRef.current = {
          ...statsRef.current,
          lastRecvAt: Date.now(),
          recvs: statsRef.current.recvs + 1,
        };
        setSceneElements(reconciledEls);
        rerender();
      });

      socket.emit('join', { sheetId });
    })();

    return () => {
      cancelled = true;
      socket?.disconnect();
    };
  }, [sheetId, loadImages, rerender]);

  const scheduleOverlayUpdate = useCallback(
    (elements: ExcalidrawElement[], appState: AppState) => {
      if (rafRef.current !== null) return;
      rafRef.current = window.requestAnimationFrame(() => {
        rafRef.current = null;
        setSceneElements(elements);
        setViewport({
          scrollX: appState.scrollX,
          scrollY: appState.scrollY,
          zoom: appState.zoom.value,
        });
      });
    },
    [],
  );

  const onChange = useCallback(
    (elements: readonly ExcalidrawElement[], appState: AppState) => {
      const liveApi = apiRef.current;
      if (!liveApi) return;

      const imgByImageId = new Map<string, ExcalidrawElement>();
      for (const el of elements) {
        if (el.isDeleted) continue;
        const data = dataOf(el);
        if (data?.kind === 'image') imgByImageId.set(data.imageId, el);
      }

      let anyClamped = false;
      const afterClamp = elements.map((el) => {
        if (el.isDeleted) return el;
        const data = dataOf(el);
        if (data?.kind !== 'region') return el;
        const img = imgByImageId.get(data.imageId);
        if (!img) return el;
        const frac: Fraction = toFraction(rectOf(el), rectOf(img));
        const inBounds =
          frac.fx >= -1e-6 &&
          frac.fy >= -1e-6 &&
          frac.fx + frac.fw <= 1 + 1e-6 &&
          frac.fy + frac.fh <= 1 + 1e-6;
        if (inBounds) return el;
        const clamped = clampFraction(frac);
        const rect = fromFraction(clamped, rectOf(img));
        const same =
          Math.abs(rect.x - el.x) < 0.01 &&
          Math.abs(rect.y - el.y) < 0.01 &&
          Math.abs(rect.width - el.width) < 0.01 &&
          Math.abs(rect.height - el.height) < 0.01;
        if (same) return el;
        anyClamped = true;
        return newElementWith(el, rect);
      });

      if (anyClamped) {
        liveApi.updateScene({
          elements: afterClamp,
          captureUpdate: CaptureUpdateAction.NEVER,
        });
        return;
      }

      const syncable = elements.filter(isSyncable);
      const sig = signature(syncable);
      if (sig !== lastEmittedSig.current) {
        lastEmittedSig.current = sig;
        if (emitTimer.current !== null) window.clearTimeout(emitTimer.current);
        emitTimer.current = window.setTimeout(() => {
          socketRef.current?.emit('scene', { elements: syncable });
          statsRef.current = {
            ...statsRef.current,
            lastEmitAt: Date.now(),
            emits: statsRef.current.emits + 1,
          };
          rerender();
        }, 100);
      }

      scheduleOverlayUpdate(elements as ExcalidrawElement[], appState);
      rerender();
    },
    [scheduleOverlayUpdate, rerender],
  );

  if (denied) {
    return <div className="page">join denied: {denied}</div>;
  }
  if (!sheetInfo) {
    return <div className="page">loading…</div>;
  }

  const selected = tools.getSelected();
  const s = statsRef.current;
  const lastSyncAt = Math.max(s.lastEmitAt ?? 0, s.lastRecvAt ?? 0);
  const lastSyncMs = lastSyncAt ? Date.now() - lastSyncAt : null;

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 41px)' }}>
      <div style={{ flex: 1, position: 'relative' }}>
        <Excalidraw excalidrawAPI={setApi} onChange={onChange} />
        <Overlay
          rows={foreignRows}
          elements={sceneElements}
          viewport={viewport}
          offset={{ left: 0, top: 0 }}
          selectedId={selectedForeignId}
          onSelect={(sid) => {
            tools.select(sid);
            rerender();
          }}
        />
        <div className="status-line" data-testid="status">
          user={session?.user.email ?? '-'} sheet={sheetInfo.name} peers=
          {peers.join(',') || '-'} foreign={foreignShapesRef.current.length}{' '}
          lastSync={lastSyncMs === null ? '-' : `${lastSyncMs}ms`}
        </div>
      </div>
      <div
        style={{ width: 280, borderLeft: '1px solid #ddd', overflow: 'auto' }}
      >
        <div
          style={{ padding: 8, borderBottom: '1px solid #eee', fontSize: 13 }}
        >
          <div>
            <b>{sheetInfo.name}</b>
          </div>
          <div className="muted">{sheetInfo.images.length} images</div>
        </div>
        <Inspector
          selected={selected}
          onSetProperty={tools.setProperty}
          onRemoveProperty={tools.removeProperty}
          onCopyForeign={(fid) => {
            tools.copyForeign(fid);
            rerender();
          }}
        />
      </div>
    </div>
  );
}
