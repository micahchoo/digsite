// The document (docs/design.md "web/" § "The sheet page"). Mounts one
// Excalidraw with the snapshot delivered by the socket's `joined` payload,
// loads every image file, and wires window.__digsite (tools.ts) plus the
// foreign overlay (overlay/) — which never touches this scene, per
// ../.claude/rules/foreign-never-in-scene.md.
import { dataOf, fileId } from '@digsite/shared';
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
import { RenameInline } from '../components/RenameInline.tsx';
import { SERVER_ORIGIN, api } from '../lib/api.ts';
import { useSession } from '../lib/auth.ts';
import { DrawLayer } from './DrawLayer.tsx';
import { Inspector } from './Inspector.tsx';
import { Toolbar } from './Toolbar.tsx';
import { clampRegion } from './clamp.ts';
import { type CascadeElement, applyCascade } from './dangling.ts';
import type { Tool } from './gestures.ts';
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

/** applyCascade (dangling.ts) is pure and returns plain patched objects —
 * this wraps that in Excalidraw's version-bump convention
 * (`newElementWith`), and ONLY for elements the cascade actually touched,
 * so an untouched element's `version` never bumps and nothing spuriously
 * re-syncs. */
function applyCascadeToScene(elements: readonly ExcalidrawElement[]): {
  elements: ExcalidrawElement[];
  changed: boolean;
} {
  const result = applyCascade(elements as unknown as CascadeElement[]);
  if (!result.changed)
    return { elements: elements as ExcalidrawElement[], changed: false };
  const next = result.elements.map((patched, i) => {
    const original = elements[i];
    if (!original || patched === (original as unknown as CascadeElement)) {
      return original as ExcalidrawElement;
    }
    // biome-ignore lint/suspicious/noExplicitAny: a cascade patch is a generic subset of one Excalidraw element variant
    return newElementWith(original, patched as any);
  });
  return { elements: next, changed: true };
}

function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/** A missing image's file (docs/phases/3-groups.md section 4): the
 * original is gone server-side (`GET /images/:id/original` 404s — see
 * ../stub/server.ts), so this is drawn locally instead of fetched, keyed
 * the same as a real file so the scene's existing image element (and its
 * `fileId`) needs no change. */
function placeholderDataURL(name: string): string {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#e9ecef';
    ctx.fillRect(0, 0, 256, 256);
    ctx.strokeStyle = '#adb5bd';
    ctx.lineWidth = 4;
    ctx.strokeRect(4, 4, 248, 248);
    ctx.fillStyle = '#868e96';
    ctx.font = '20px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('missing', 128, 112);
    ctx.font = '13px sans-serif';
    ctx.fillText(name.slice(0, 24), 128, 144);
  }
  return canvas.toDataURL('image/png');
}

export function Sheet() {
  const { id } = useParams<{ id: string }>();
  const sheetId = id ?? '';
  const { data: session } = useSession();

  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const loadedImages = useRef<Set<string>>(new Set());
  // Populated from GET /sheets/:id's per-image `missing`/`name` (additive,
  // see lib/api.ts's GetSheetResponseWithStatus) before `loadImages` runs,
  // so a missing image never even attempts the network fetch.
  const imageMetaRef = useRef<Map<string, { missing: boolean; name: string }>>(
    new Map(),
  );
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
  const [tool, setToolState] = useState<Tool>('select');
  const toolRef = useRef<Tool>('select');
  const [pendingEdge, setPendingEdge] = useState(false);

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

  // setTool is the one place Excalidraw's own activeTool is set — select and
  // pan map onto its built-in tools; region and edge become {type: 'custom'}
  // (research/excalidraw: a custom tool gets no built-in pointer behaviour,
  // so DrawLayer never fights Excalidraw's own drag-select/hand-pan). See
  // Toolbar.tsx's header comment.
  const applyTool = useCallback((next: Tool) => {
    toolRef.current = next;
    setToolState(next);
    const liveApi = apiRef.current;
    if (!liveApi) return;
    if (next === 'select') liveApi.setActiveTool({ type: 'selection' });
    else if (next === 'pan') liveApi.setActiveTool({ type: 'hand' });
    else liveApi.setActiveTool({ type: 'custom', customType: next });
  }, []);

  if (!toolsRef.current) {
    toolsRef.current = createTools({
      getApi: () => apiRef.current,
      getForeignShapes: () => foreignShapesRef.current,
      getSelectedForeignId: () => selectedForeignRef.current,
      setSelectedForeign: applySelectedForeign,
      getSyncStatus: () => ({ ...statsRef.current }),
      getTool: () => toolRef.current,
      setTool: applyTool,
      getSheetId: () => sheetId,
      onRenamed: (name) =>
        setSheetInfo((prev) => (prev ? { ...prev, name } : prev)),
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
        const known = imageMetaRef.current.get(imageId);
        // Known missing: never fetched — the original is gone server-side.
        // Unknown or not-yet-missing: fetch, and fall back to the same
        // placeholder if it 404s (an image deleted after this sheet's own
        // GET /sheets/:id, before the socket's 'joined' snapshot loaded it).
        if (!known?.missing) {
          try {
            const res = await fetch(api.originalUrl(imageId), {
              credentials: 'include',
            });
            if (!res.ok)
              throw new Error(`original fetch failed: ${res.status}`);
            const blob = await res.blob();
            const dataURL = await blobToDataURL(blob);
            return {
              id: fileId(imageId),
              dataURL,
              mimeType: blob.type || 'image/png',
              created: Date.now(),
            };
          } catch {
            // fall through to the placeholder below
          }
        }
        return {
          id: fileId(imageId),
          dataURL: placeholderDataURL(known?.name ?? imageId),
          mimeType: 'image/png',
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
      for (const img of info.images) {
        imageMetaRef.current.set(img.id, {
          missing: img.missing,
          name: img.name,
        });
      }
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

      // 1. clamp every region against its image's CURRENT rect, only
      // rewriting one whose clamp actually changed it (clamp.ts).
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
        const corrected = clampRegion(rectOf(el), rectOf(img));
        if (!corrected) return el;
        anyClamped = true;
        return newElementWith(el, corrected);
      });

      // 2. the delete cascade + dangling rebind (dangling.ts section 1/5):
      // an image delete takes its regions and edges with it; a region
      // delete rebinds its edge to the image instead, tagged dangling.
      const cascaded = applyCascadeToScene(afterClamp as ExcalidrawElement[]);
      const finalElements = cascaded.elements;

      if (anyClamped || cascaded.changed) {
        liveApi.updateScene({
          elements: finalElements,
          captureUpdate: CaptureUpdateAction.NEVER,
        });
      }

      const syncable = finalElements.filter(isSyncable);
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

      scheduleOverlayUpdate(finalElements, appState);
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
  const dangling = tools.getDangling();

  return (
    <div
      className="digsite-sheet"
      style={{ display: 'flex', height: 'calc(100vh - 41px)' }}
    >
      {/* Excalidraw 0.18 has no UIOptions flag for hiding individual shape
          tools (see Toolbar.tsx's header comment) — hide the stock
          `.shapes-section` island by CSS, scoped to this page, leaving the
          zoom controls and undo/redo footer (separate Sections) alone. */}
      <style>
        {'.digsite-sheet .shapes-section { display: none !important; }'}
      </style>
      <div style={{ flex: 1, position: 'relative' }}>
        <Excalidraw excalidrawAPI={setApi} onChange={onChange} />
        <DrawLayer
          tool={tool}
          tools={tools}
          elements={sceneElements}
          viewport={viewport}
          offset={{ left: 0, top: 0 }}
          onPendingEdgeChange={setPendingEdge}
          onDrawn={rerender}
        />
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
        <Toolbar tool={tool} onChange={applyTool} pendingEdge={pendingEdge} />
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
          <RenameInline
            name={sheetInfo.name}
            onRename={tools.rename}
            testId="sheet-name"
            style={{ fontWeight: 700 }}
          />
          <div className="muted">{sheetInfo.images.length} images</div>
        </div>
        {dangling.length > 0 && (
          <div
            data-testid="dangling-list"
            style={{ padding: 8, borderBottom: '1px solid #eee', fontSize: 13 }}
          >
            <div>
              <b>dangling ({dangling.length})</b>
            </div>
            {dangling.map((d) => (
              <div key={d.id} className="muted">
                {d.relation || '(no relation)'}
              </div>
            ))}
            <button
              type="button"
              data-testid="remove-dangling"
              onClick={() => {
                tools.removeDangling();
                rerender();
              }}
            >
              Remove dangling
            </button>
          </div>
        )}
        <Inspector
          selected={selected}
          onSetProperty={tools.setProperty}
          onRemoveProperty={tools.removeProperty}
          onCopyForeign={(fid) => {
            tools.copyForeign(fid);
            rerender();
          }}
          onDeleteSelected={() => {
            tools.deleteSelected();
            rerender();
          }}
        />
      </div>
    </div>
  );
}
