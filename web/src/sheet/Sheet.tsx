import { dataOf } from '@digsite/shared';
// Composition only: loads the sheet, owns its room and foreign poll, and
// lays out the page. Imperative canvas work goes through `CanvasHandle`.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import {
  ErrorState,
  type ErrorStateInfo,
  fromCaught,
} from '../components/ErrorState.tsx';
import { api } from '../lib/api.ts';
import { useSession } from '../lib/auth.ts';
import { DrawLayer } from './DrawLayer.tsx';
import { SidePanel } from './SidePanel.tsx';
import { Canvas } from './canvas/Canvas.tsx';
import type {
  CanvasFile,
  CanvasHandle,
  SceneChange,
  SceneElement,
  Viewport,
} from './canvas/types.ts';
import { type ImageMeta, loadImageFiles } from './images.ts';
import { Overlay } from './overlay/Overlay.tsx';
import { screenToScene } from './overlay/screen.ts';
import { peerCursors } from './presence.ts';
import { useRoom } from './room.ts';
import { reconcileLocalChange } from './scene-diff.ts';
import './sheet.css';
import { Toolbar } from './Toolbar.tsx';
import {
  type PendingCopyEdge,
  useCopyConnections,
} from './use-copy-connections.ts';
import { useForeignShapes } from './use-foreign-shapes.ts';
import { useSheetTools } from './use-sheet-tools.ts';

export type { PendingCopyEdge };

type SheetInfo = Awaited<ReturnType<typeof api.getSheet>>;
const ZERO_VIEWPORT: Viewport = { scrollX: 0, scrollY: 0, zoom: 1 };

export function Sheet() {
  const { id } = useParams<{ id: string }>();
  const sheetId = id ?? '';
  const location = useLocation();
  const navigate = useNavigate();
  const { data: session } = useSession();

  const canvasRef = useRef<CanvasHandle | null>(null);
  const inspectorToggleRef = useRef<HTMLButtonElement | null>(null);
  const inspectorCloseRef = useRef<HTMLButtonElement | null>(null);
  const imageMetaRef = useRef(new Map<string, ImageMeta>());
  const latestRef = useRef<{
    elements: SceneElement[];
    viewport: Viewport;
  } | null>(null);
  const flushQueued = useRef(false);
  const [sheetInfo, setSheetInfo] = useState<SheetInfo | null>(null);
  const [boardSheets, setBoardSheets] = useState<
    Awaited<ReturnType<typeof api.listSheets>>
  >([]);
  const [mobileInspectorOpen, setMobileInspectorOpen] = useState(false);
  const [connectionRelation, setConnectionRelation] = useState<string | null>(
    null,
  );
  const [files, setFiles] = useState(new Map<string, CanvasFile>());
  const [sceneElements, setSceneElements] = useState<SceneElement[]>([]);
  const [viewport, setViewport] = useState<Viewport>(ZERO_VIEWPORT);
  const [pendingEdge, setPendingEdge] = useState(false);
  const [, bumpTick] = useState(0);
  const rerender = useCallback(() => bumpTick((n) => n + 1), []);
  const loadImages = useCallback(async (imageIds: string[]) => {
    const next = await loadImageFiles(imageIds, imageMetaRef.current);
    setFiles((prev) => {
      const merged = new Map(prev);
      for (const [k, v] of next) if (!merged.has(k)) merged.set(k, v);
      return merged;
    });
  }, []);

  const room = useRoom({
    // The canvas is rendered only after this sheet's metadata resolves. Join
    // at that point so the initial `joined` snapshot always has a handle to
    // apply to (otherwise a fast socket response can be silently dropped).
    sheetId: sheetInfo?.id === sheetId ? sheetId : '',
    getHandle: () => canvasRef.current,
    loadImages,
    onRemoteChange: () => {
      setSceneElements(canvasRef.current?.elements() ?? []);
      setViewport(canvasRef.current?.viewport() ?? ZERO_VIEWPORT);
    },
  });
  const foreign = useForeignShapes(sheetId, sceneElements);
  const { tools, tool, setTool, selectedForeignId } = useSheetTools({
    sheetId,
    getHandle: () => canvasRef.current,
    getForeignShapes: () => foreign.ref.current,
    getSyncStatus: () => room.getStatus(),
    onRenamed: (name) =>
      setSheetInfo((prev) => (prev ? { ...prev, name } : prev)),
  });

  const [sheetError, setSheetError] = useState<ErrorStateInfo | null>(null);
  useEffect(() => {
    if (!sheetId) return;
    let cancelled = false;
    setSheetError(null);
    setSheetInfo(null);
    setBoardSheets([]);
    setMobileInspectorOpen(false);
    setConnectionRelation(null);
    // docs/ux/audit.md #1: a sheet the viewer can't or shouldn't see used to
    // hang on "loading…" forever — this call had no `.catch()` at all.
    void (async () => {
      try {
        const info = await api.getSheet(sheetId);
        if (cancelled) return;
        setSheetInfo(info);
        imageMetaRef.current = new Map(info.images.map((img) => [img.id, img]));
        void loadImages(info.images.map((i) => i.id));
      } catch (err) {
        if (cancelled) return;
        setSheetError(fromCaught(err, 'sheet'));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sheetId, loadImages]);
  useEffect(() => {
    const boardId = sheetInfo?.boardId;
    if (!boardId) return;
    let cancelled = false;
    void api
      .listSheets(boardId)
      .then((sheets) => {
        if (!cancelled) setBoardSheets(sheets);
      })
      .catch(() => {
        if (!cancelled) setBoardSheets([]);
      });
    return () => {
      cancelled = true;
    };
  }, [sheetInfo?.boardId]);
  useEffect(() => {
    if (!mobileInspectorOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && !e.defaultPrevented)
        setMobileInspectorOpen(false);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mobileInspectorOpen]);
  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 768px)');
    const closeOnDesktop = () => {
      if (desktop.matches) setMobileInspectorOpen(false);
    };
    closeOnDesktop();
    desktop.addEventListener('change', closeOnDesktop);
    return () => desktop.removeEventListener('change', closeOnDesktop);
  }, []);
  const onCanvasChange = useCallback(
    (scene: SceneChange) => {
      const handle = canvasRef.current;
      if (!handle) return;
      const { ops, elements: next } = reconcileLocalChange(scene.elements);
      if (ops.length) handle.apply(ops, { history: false });
      room.sendScene(next);
      // Coalesce a burst of changes into one render, but always flush the
      // LATEST one: an animation-frame closure over the first change dropped
      // every later change in that frame (a fit right after a relayed scene
      // never reached the overlay), and a background page may not get a
      // frame at all. A microtask runs after the burst, everywhere.
      latestRef.current = { elements: next, viewport: scene.viewport };
      if (!flushQueued.current) {
        flushQueued.current = true;
        queueMicrotask(() => {
          flushQueued.current = false;
          const latest = latestRef.current;
          if (!latest) return;
          setSceneElements(latest.elements);
          setViewport(latest.viewport);
        });
      }
      // `room` is a fresh object every render; `sendScene`'s identity is
      // stable (room.ts's own useCallback) — depend on that, not the whole
      // object, so this handler is never rebuilt yet never goes stale.
    },
    [room.sendScene],
  );
  const focusInspectorToggle = useCallback(
    () => inspectorToggleRef.current?.focus(),
    [],
  );

  const onPointerMoveForPresence = useCallback(
    (e: React.PointerEvent) => {
      const handle = canvasRef.current;
      if (!handle) return;
      const box = e.currentTarget.getBoundingClientRect();
      const client = { x: e.clientX - box.left, y: e.clientY - box.top };
      const p = screenToScene(client, viewport, { left: 0, top: 0 });
      room.sendPointer(p.x, p.y, handle.selectedIds());
    },
    [viewport, room.sendPointer],
  );
  const panCanvas = useCallback((dx: number, dy: number) => {
    const handle = canvasRef.current;
    if (!handle) return;
    const current = handle.viewport();
    handle.setViewport({
      scrollX: current.scrollX + dx / current.zoom,
      scrollY: current.scrollY + dy / current.zoom,
    });
  }, []);
  const wheelCanvas = useCallback(
    (
      input: Parameters<CanvasHandle['wheel']>[0],
      point: { x: number; y: number },
    ) => canvasRef.current?.wheel(input, point),
    [],
  );

  const peerCursorList = useMemo(
    () => peerCursors(room.peerPointers, sceneElements),
    [room.peerPointers, sceneElements],
  );
  type LocationState = { copyEdges?: PendingCopyEdge[] } | null;
  const copyEdges = (location.state as LocationState)?.copyEdges;
  useCopyConnections(copyEdges, sceneElements, tools, rerender);
  const sheetIndex = boardSheets.findIndex((sheet) => sheet.id === sheetId);
  const previousSheet =
    sheetIndex > 0 ? (boardSheets[sheetIndex - 1] ?? null) : null;
  const nextSheet =
    sheetIndex >= 0 && sheetIndex < boardSheets.length - 1
      ? (boardSheets[sheetIndex + 1] ?? null)
      : null;
  const connectionRelations = Array.from(
    new Set([
      ...foreign.rows.edges.map((edge) => edge.relation),
      ...sceneElements.flatMap((element) => {
        if (element.isDeleted) return [];
        const data = dataOf(element);
        return data?.kind === 'edge' ? [data.relation] : [];
      }),
    ]),
  ).sort((a, b) => a.localeCompare(b));
  const currentImageCount = sceneElements.filter(
    (element) => !element.isDeleted && dataOf(element)?.kind === 'image',
  ).length;
  const selected = tools.getSelected();
  const selectedOwnId =
    selected?.kind === 'own' && selected.elements.length === 1
      ? (selected.elements[0]?.id ?? null)
      : null;

  if (sheetError) return <ErrorState info={sheetError} />;
  if (room.denied) {
    // The stub (and the real room.ts) give one reason string with no HTTP
    // status attached — 'not found' is the sheet-doesn't-exist case
    // (docs/ux/audit.md's error-cases table: "join denied: sheet not
    // found" read as real-time-collab jargon for a plain 404); anything
    // else is an access denial from the same `boardForViewing` predicate
    // the sheet's board uses.
    const status = room.denied === 'not found' ? 404 : 403;
    return (
      <ErrorState info={{ status, reason: room.denied, resource: 'sheet' }} />
    );
  }
  if (!sheetInfo) return <div className="page">loading…</div>;

  return (
    <div className="sheet-page">
      <div
        className="sheet-canvas-area"
        aria-hidden={mobileInspectorOpen || undefined}
        inert={mobileInspectorOpen}
        onPointerMove={onPointerMoveForPresence}
      >
        <Canvas
          ref={canvasRef}
          files={files}
          tool={tool}
          dimRelations={connectionRelation}
          onChange={onCanvasChange}
        />
        <DrawLayer
          tool={tool}
          tools={tools}
          elements={sceneElements}
          viewport={viewport}
          offset={{ left: 0, top: 0 }}
          onPendingEdgeChange={setPendingEdge}
          onDrawn={rerender}
          onPan={panCanvas}
          onWheel={wheelCanvas}
        />
        <Overlay
          rows={foreign.rows}
          elements={sceneElements}
          viewport={viewport}
          offset={{ left: 0, top: 0 }}
          selectedId={selectedForeignId}
          selectedOwnId={selectedOwnId}
          connectionRelation={connectionRelation}
          onSelect={(sid) => tools.select(sid)}
          onSelectOwn={(elementId) => canvasRef.current?.select([elementId])}
          peers={peerCursorList}
        />
        <button
          ref={inspectorToggleRef}
          type="button"
          className="sheet-mobile-inspector-toggle"
          aria-controls="sheet-inspector-panel"
          aria-expanded={mobileInspectorOpen}
          onClick={() => setMobileInspectorOpen((open) => !open)}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M3 4.5h14M3 10h14M3 15.5h14" />
            <circle cx="7" cy="4.5" r="1.5" />
            <circle cx="13" cy="10" r="1.5" />
            <circle cx="8" cy="15.5" r="1.5" />
          </svg>
          <span>Details</span>
        </button>
        <Toolbar
          tool={tool}
          onChange={setTool}
          pendingEdge={pendingEdge}
          canvas={canvasRef.current}
        />
      </div>
      {mobileInspectorOpen && (
        <button
          type="button"
          className="sheet-mobile-inspector-backdrop"
          aria-label="Dismiss sheet details"
          onClick={() => setMobileInspectorOpen(false)}
        />
      )}
      <SidePanel
        header={{
          name: sheetInfo.name,
          onRename: tools.rename,
          imageCount: currentImageCount,
          peers: room.peers,
          userEmail: session?.user.email,
          foreignCount: foreign.shapes.length,
          status: room.getStatus(),
          boardId: sheetInfo.boardId,
          sheetId,
          previousSheet,
          nextSheet,
          onNavigateSheet: (id) => navigate(`/s/${id}`),
          onCloseMobile: () => setMobileInspectorOpen(false),
          closeButtonRef: inspectorCloseRef,
          foreignRelations: connectionRelations,
          connectionRelation,
          onConnectionRelationChange: setConnectionRelation,
        }}
        dangling={tools.getDangling()}
        onRemoveDangling={() => tools.removeDangling()}
        selected={selected}
        onSetProperty={tools.setProperty}
        onRemoveProperty={tools.removeProperty}
        onCopyForeign={(fid) => tools.copyForeign(fid)}
        onDeleteSelected={() => tools.deleteSelected()}
        mobileOpen={mobileInspectorOpen}
        onFocusToggle={focusInspectorToggle}
      />
    </div>
  );
}
