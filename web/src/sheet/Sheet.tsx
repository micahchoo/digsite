import {
  DEFAULT_SORT,
  type GetSheetReachResponse,
  dataOf,
  fileId,
  sortId,
} from '@digsite/shared';
// Composition only: loads the sheet, owns its room and foreign poll, and
// lays out the page. Imperative canvas work goes through `CanvasHandle`.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import { ContextMenu, type MenuSection } from '../board/ContextMenu.tsx';
import { WebView } from '../board/WebView.tsx';
import { Compare, type CompareEnd } from '../components/Compare.tsx';
import {
  ErrorState,
  type ErrorStateInfo,
  fromCaught,
} from '../components/ErrorState.tsx';
import { Icon } from '../components/Icon.tsx';
import { WHOLE } from '../components/compare-view.ts';
import { api } from '../lib/api.ts';
import { useSession } from '../lib/auth.ts';
import { modalOpen } from '../lib/modal.ts';
import { useVocabulary, withLocalTerms } from '../lib/vocabulary.ts';
import { ConnectLayer } from './ConnectLayer.tsx';
import { DrawLayer } from './DrawLayer.tsx';
import { RelationPicker } from './RelationPicker.tsx';
import { SidePanel } from './SidePanel.tsx';
import {
  type PendingCopyEdge,
  createSheetActions,
  imageElementOf,
} from './actions.ts';
import { describeSelection } from './announce.ts';
import { type Direction, nextInDirection } from './arrow-walk.ts';
import { Canvas } from './canvas/Canvas.tsx';
import type {
  CanvasFile,
  CanvasHandle,
  SceneChange,
  SceneElement,
  Viewport,
} from './canvas/types.ts';
import { cropToDataUrl } from './crop.ts';
import { type ImageMeta, loadImageFiles } from './images.ts';
import { Overlay } from './overlay/Overlay.tsx';
import { Reach } from './overlay/Reach.tsx';
import { revealRect, sceneToScreen, screenToScene } from './overlay/screen.ts';
import { usePolled } from './overlay/usePolled.ts';
import { peerCursors } from './presence.ts';
import { nextImage } from './reading-order.ts';
import { buildReport } from './report.ts';
import { useRoom } from './room.ts';
import { reconcileLocalChange } from './scene-diff.ts';
import { type MenuTarget, sheetMenu } from './sheet-menu.ts';
import './sheet.css';
import { Toolbar } from './Toolbar.tsx';
import { useCopyConnections } from './use-copy-connections.ts';
import { useForeignShapes } from './use-foreign-shapes.ts';
import { useSheetTools } from './use-sheet-tools.ts';

type SheetInfo = Awaited<ReturnType<typeof api.getSheet>>;
const ZERO_VIEWPORT: Viewport = { scrollX: 0, scrollY: 0, zoom: 1 };
const NO_REACH: GetSheetReachResponse = { edges: [], images: [] };

export function Sheet() {
  const { id } = useParams<{ id: string }>();
  const sheetId = id ?? '';
  const location = useLocation();
  const navigate = useNavigate();
  const { data: session } = useSession();
  const authorRef = useRef<{ id: string; name: string } | null>(null);
  authorRef.current = session
    ? {
        id: session.user.id,
        name:
          session.user.name || session.user.email.split('@')[0] || 'Someone',
      }
    : null;

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
  // Read by the sheet's actions, which are made once (actions.ts).
  const sheetInfoRef = useRef(sheetInfo);
  sheetInfoRef.current = sheetInfo;
  const filesRef = useRef(files);
  filesRef.current = files;
  const [sceneElements, setSceneElements] = useState<SceneElement[]>([]);
  const [viewport, setViewport] = useState<Viewport>(ZERO_VIEWPORT);
  const [pendingEdge, setPendingEdge] = useState(false);
  /** A connection just made, being named where it landed. */
  const [naming, setNaming] = useState<{
    edgeId: string;
    at: { x: number; y: number };
  } | null>(null);
  const captions = useMemo(
    () => new Map(sheetInfo?.images.map((img) => [img.id, img.name]) ?? []),
    [sheetInfo],
  );
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    sections: MenuSection[];
  } | null>(null);
  const [help, setHelp] = useState(false);
  /** The web view's starting pictures, while it is open. */
  const [webRoots, setWebRoots] = useState<string[] | null>(null);
  /** A long action in progress, said where the person is looking. */
  const [working, setWorking] = useState<string | null>(null);
  const [comparing, setComparing] = useState<{
    a: CompareEnd;
    b: CompareEnd;
    title: string;
  } | null>(null);
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
  const reach = usePolled(sheetId, api.getSheetReach, NO_REACH);
  const { tools, tool, setTool, selectedForeignId } = useSheetTools({
    sheetId,
    getHandle: () => canvasRef.current,
    getForeignShapes: () => foreign.ref.current,
    getSyncStatus: () => room.getStatus(),
    onRenamed: (name) =>
      setSheetInfo((prev) => (prev ? { ...prev, name } : prev)),
    // Read through a ref: the tools are made once, the session arrives later.
    getAuthor: () => authorRef.current,
  });

  /** Everything the sheet does in more than one step (actions.ts). */
  const actions = useMemo(
    () =>
      createSheetActions({
        sheetId,
        boardId: () => sheetInfoRef.current?.boardId ?? null,
        scene: () => canvasRef.current,
        tools,
        server: api,
        crop: (imageId, fraction) =>
          cropToDataUrl(
            filesRef.current.get(fileId(imageId))?.dataURL ??
              api.previewUrl(imageId),
            fraction,
          ),
        nameOf: (imageId) =>
          sheetInfoRef.current?.images.find((img) => img.id === imageId)
            ?.name ?? 'picture',
        origin: window.location.origin,
        changed: rerender,
      }),
    [sheetId, tools, rerender],
  );

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
      if (e.key === 'Escape' && !e.defaultPrevented && !modalOpen())
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
  // A sheet opens framed on its pictures, in the canvas it actually has:
  // beside a docked details column that is narrower than the window, and a
  // fixed opening view left a whole column of pictures off screen. Once
  // per sheet, on its first scene, so a later edit never moves the view.
  const fittedRef = useRef<string | null>(null);
  const hasScene = sceneElements.length > 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per sheet, when its first scene lands; the claim link is read at that moment, and rerender is stable
  useEffect(() => {
    if (!hasScene || fittedRef.current === sheetId) return;
    fittedRef.current = sheetId;
    const canvas = canvasRef.current;
    canvas?.zoomToFit();
    // `?claim=<element id>`: a link to one claim (a report links each one
    // here). Select it and frame it with what it rests on.
    const claimId = new URLSearchParams(location.search).get('claim');
    const claim = claimId
      ? canvas?.elements().find((el) => el.id === claimId && !el.isDeleted)
      : undefined;
    if (canvas && claim) {
      const around = [
        claim.id,
        claim.startBinding?.elementId,
        claim.endBinding?.elementId,
      ].filter((id): id is string => !!id);
      canvas.zoomToFit(around);
      canvas.select([claim.id]);
      rerender();
    }
  }, [hasScene, sheetId]);
  const onCanvasChange = useCallback(
    (scene: SceneChange) => {
      const handle = canvasRef.current;
      if (!handle) return;
      tools.ownSelected(scene.selectedIds);
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
      // `tools` is made once (use-sheet-tools.ts).
    },
    [room.sendScene, tools],
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
      const p = screenToScene(client, viewport);
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
  useCopyConnections(copyEdges, sceneElements, actions);
  const sheetIndex = boardSheets.findIndex((sheet) => sheet.id === sheetId);
  const previousSheet =
    sheetIndex > 0 ? (boardSheets[sheetIndex - 1] ?? null) : null;
  const nextSheet =
    sheetIndex >= 0 && sheetIndex < boardSheets.length - 1
      ? (boardSheets[sheetIndex + 1] ?? null)
      : null;
  // Every relation drawn on this sheet, own and other sheets', with how
  // many connections carry it: the header lists them to emphasise one.
  const connectionRelations = (() => {
    const counts = new Map<string, number>();
    const add = (relation: string) =>
      counts.set(relation, (counts.get(relation) ?? 0) + 1);
    for (const edge of foreign.rows.edges) add(edge.relation);
    for (const element of sceneElements) {
      if (element.isDeleted) continue;
      const data = dataOf(element);
      if (data?.kind === 'edge') add(data.relation);
    }
    return [...counts]
      .map(([relation, count]) => ({ relation, count }))
      .sort(
        (a, b) => b.count - a.count || a.relation.localeCompare(b.relation),
      );
  })();
  const currentImageCount = sceneElements.filter(
    (element) => !element.isDeleted && dataOf(element)?.kind === 'image',
  ).length;
  const selected = tools.getSelected();
  const selectedOwnId =
    selected?.kind === 'own' && selected.elements.length === 1
      ? (selected.elements[0]?.id ?? null)
      : null;
  const selectedOwnKey =
    selected?.kind === 'own'
      ? selected.elements.map((el) => el.id).join(' ')
      : '';
  const selectedOwnIds = useMemo(
    () => (selectedOwnKey ? selectedOwnKey.split(' ') : []),
    [selectedOwnKey],
  );

  // The board's vocabulary, plus what this sheet has typed that the rows
  // do not hold until the next save (CONTEXT.md "Vocabulary").
  const vocab = useVocabulary(sheetInfo?.boardId ?? null);
  const { labelTerms, relationTerms } = useMemo(() => {
    const labels: string[] = [];
    const relations: string[] = [];
    for (const el of sceneElements) {
      if (el.isDeleted) continue;
      const data = dataOf(el);
      if (data?.kind === 'region') labels.push(data.label);
      if (data?.kind === 'edge') relations.push(data.relation);
    }
    const { aliases } = vocab.vocabulary;
    return {
      labelTerms: withLocalTerms(
        vocab.vocabulary.labels,
        labels,
        aliases.label,
      ),
      relationTerms: withLocalTerms(
        vocab.vocabulary.relations,
        relations,
        aliases.relation,
      ),
    };
  }, [sceneElements, vocab.vocabulary]);
  const refreshVocabulary = vocab.refresh;
  useEffect(() => {
    if (naming) refreshVocabulary();
  }, [naming, refreshVocabulary]);

  // The connect handle: one selected own image or region, Select tool.
  const selectedOwn =
    selectedOwnId && tool === 'select' && !naming
      ? (sceneElements.find((el) => el.id === selectedOwnId) ?? null)
      : null;
  const connectSource =
    selectedOwn && ['image', 'region'].includes(dataOf(selectedOwn)?.kind ?? '')
      ? selectedOwn
      : null;
  const namingEdge = naming
    ? sceneElements.find((el) => el.id === naming.edgeId && !el.isDeleted)
    : undefined;
  const namingData = namingEdge ? dataOf(namingEdge) : null;

  /** The element that shows `imageId` on this sheet, if any. */
  function imageElement(imageId: string): SceneElement | undefined {
    const canvas = canvasRef.current;
    return canvas ? imageElementOf(canvas.elements(), imageId) : undefined;
  }

  /** A region made into a picture of its own (CONTEXT.md "Extract"),
   * each step said where the person is looking. */
  async function extractToPicture(regionId: string) {
    try {
      await actions.extract(regionId, setWorking);
      setWorking(null);
    } catch (err) {
      setWorking(
        `Could not make the picture: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
      window.setTimeout(() => setWorking(null), 6000);
    }
  }

  /**
   * A report of this sheet's claims, downloaded as one HTML file that
   * carries its own pictures (report.ts): the work, shown to someone who
   * does not use digsite.
   */
  async function exportReport() {
    const info = sheetInfo;
    if (!info) return;
    setWorking('Making the report…');
    try {
      const claims = await actions.reportClaims();
      const boardName =
        (await api.getBoard(info.boardId).catch(() => null))?.name ?? '';
      const html = buildReport({
        sheetName: info.name,
        boardName,
        by: authorRef.current?.name ?? 'someone',
        at: new Date().toISOString(),
        link: `${window.location.origin}/s/${sheetId}`,
        claims,
      });
      const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `${info.name.replace(/[^\w.-]+/g, '-') || 'sheet'}-report.html`;
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setWorking(null);
    } catch (err) {
      setWorking(
        `Could not make the report: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
      window.setTimeout(() => setWorking(null), 6000);
    }
  }

  /** The context menu at a client point, on what the frame shows there.
   * A right-click on something already selected keeps the selection, so
   * the items act on all of it (image-graph's `scene.holds`). */
  function openMenu(clientX: number, clientY: number, hit: MenuTarget | null) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const held = canvas.selectedIds();
    const acting = hit ? (held.includes(hit.id) ? held : [hit.id]) : [];
    if (hit && !held.includes(hit.id)) canvas.select([hit.id]);
    const area = document
      .querySelector('.sheet-canvas-area')
      ?.getBoundingClientRect();
    const at = {
      x: clientX - (area?.left ?? 0),
      y: clientY - (area?.top ?? 0),
    };
    const sections = sheetMenu(hit, acting, canvas.elements(), {
      fit: (ids) => canvas.zoomToFit(ids),
      extract: (id) => void extractToPicture(id),
      markRegion: (id) => {
        setTool('region');
        canvas.zoomToFit([id]);
      },
      rename: (edgeId) => setNaming({ edgeId, at }),
      setConfidence: (id, confidence) =>
        tools.setProperty(id, 'confidence', confidence ?? ''),
      reverse: (id) => {
        const el = canvas.elements().find((e) => e.id === id);
        const data = el ? dataOf(el) : null;
        if (data?.kind !== 'edge') return;
        tools.setProperty(
          id,
          'direction',
          data.direction === 'forward' ? 'reverse' : 'forward',
        );
      },
      remove: (ids) => {
        canvas.select(ids);
        tools.deleteSelected();
      },
      undo: () => canvas.undo(),
      redo: () => canvas.redo(),
      help: () => setHelp(true),
      report: () => void exportReport(),
    });
    rerender();
    setMenu({ x: clientX, y: clientY, sections });
  }

  // Shift+F10 and the Menu key open it on the selection, as a right-click
  // on it would.
  const openMenuRef = useRef(openMenu);
  /**
   * Arrow keys walk from picture to picture (arrow-walk.ts); Shift adds the
   * next one to the selection. The picture walked to is brought into view
   * when it is off screen. Read through a ref so the key listener, bound
   * once, always sees this render's state.
   */
  function walk(direction: Direction, add: boolean) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const pictures = canvas
      .elements()
      .filter((el) => !el.isDeleted && dataOf(el)?.kind === 'image');
    if (!pictures.length) return;
    const held = canvas.selectedIds();
    const fromId = [...held]
      .reverse()
      .find((id) => pictures.some((p) => p.id === id));
    const nextId = fromId
      ? nextInDirection(pictures, fromId, direction)
      : (nextImage(pictures, null, 1)?.id ?? null);
    if (!nextId) return;
    canvas.select(add ? [...new Set([...held, nextId])] : [nextId]);
    const el = pictures.find((p) => p.id === nextId);
    const area = document
      .querySelector('.sheet-canvas-area')
      ?.getBoundingClientRect();
    if (el && area) {
      const vp = canvas.viewport();
      const next = revealRect(el, vp, area);
      if (next !== vp) canvas.setViewport(next);
    }
    rerender();
  }
  const walkRef = useRef(walk);
  walkRef.current = walk;
  useEffect(() => {
    const ARROWS: Record<string, Direction> = {
      ArrowLeft: 'left',
      ArrowRight: 'right',
      ArrowUp: 'up',
      ArrowDown: 'down',
    };
    function onKeyDown(e: KeyboardEvent) {
      const direction = ARROWS[e.key];
      if (!direction || e.metaKey || e.ctrlKey || e.altKey || modalOpen())
        return;
      const target = e.target as HTMLElement | null;
      if (
        target?.closest(
          'input, textarea, select, [contenteditable="true"], dialog, [role="menu"], [role="radiogroup"]',
        )
      )
        return;
      e.preventDefault();
      walkRef.current(direction, e.shiftKey);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  openMenuRef.current = openMenu;
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const menuKey =
        e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10');
      if (!menuKey || modalOpen()) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"]')) return;
      const canvas = canvasRef.current;
      const area = document
        .querySelector('.sheet-canvas-area')
        ?.getBoundingClientRect();
      if (!canvas || !area) return;
      e.preventDefault();
      const [id] = canvas.selectedIds();
      const el = id ? canvas.elements().find((x) => x.id === id) : undefined;
      const data = el ? dataOf(el) : null;
      if (!el || !data) {
        openMenuRef.current(
          area.left + area.width / 2,
          area.top + area.height / 2,
          null,
        );
        return;
      }
      const centre = sceneToScreen(
        { x: el.x + el.width / 2, y: el.y + el.height / 2 },
        canvas.viewport(),
      );
      openMenuRef.current(area.left + centre.x, area.top + centre.y, {
        id: el.id,
        kind: data.kind,
      });
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

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
        onContextMenu={(e) => {
          e.preventDefault();
          // Another sheet's claim is read-only and answers its own clicks.
          const onForeign = (e.target as Element).closest?.(
            '[data-foreign-id]',
          );
          openMenu(
            e.clientX,
            e.clientY,
            onForeign
              ? null
              : (canvasRef.current?.hitAt({ x: e.clientX, y: e.clientY }) ??
                  null),
          );
        }}
      >
        <Canvas
          ref={canvasRef}
          files={files}
          tool={tool}
          dimRelations={connectionRelation}
          captions={captions}
          onChange={onCanvasChange}
        />
        <DrawLayer
          tool={tool}
          tools={tools}
          elements={sceneElements}
          viewport={viewport}
          onPendingEdgeChange={setPendingEdge}
          onDrawn={rerender}
          onEdgeDrawn={(edgeId, at) => setNaming({ edgeId, at })}
          labelTerms={labelTerms}
          suggestLabels={(imageId, region) =>
            api
              .labelSuggestions(sheetInfo.boardId, imageId, region)
              .then(({ suggestions }) => suggestions.map((x) => x.term))
              .catch(() => [])
          }
          onPan={panCanvas}
          onWheel={wheelCanvas}
        />
        <ConnectLayer
          source={connectSource}
          elements={sceneElements}
          viewport={viewport}
          connect={(from, to) => tools.connect(from, to)}
          onConnected={(edgeId, at) => {
            rerender();
            setNaming({ edgeId, at });
          }}
        />
        {naming && namingData?.kind === 'edge' && (
          <RelationPicker
            at={naming.at}
            relation={namingData.relation}
            direction={namingData.direction}
            confidence={namingData.confidence}
            terms={relationTerms}
            onRelation={(relation) =>
              tools.setProperty(naming.edgeId, 'relation', relation)
            }
            onDirection={(direction) =>
              tools.setProperty(naming.edgeId, 'direction', direction)
            }
            onConfidence={(confidence) =>
              tools.setProperty(naming.edgeId, 'confidence', confidence ?? '')
            }
            onClose={() => setNaming(null)}
          />
        )}
        <Overlay
          shapes={foreign.shapes}
          elements={sceneElements}
          viewport={viewport}
          selectedId={selectedForeignId}
          selectedOwnIds={selectedOwnIds}
          connectionRelation={connectionRelation}
          onSelect={(sid) => tools.select(sid)}
          onSelectOwn={(elementId) => canvasRef.current?.select([elementId])}
          peers={peerCursorList}
        />
        <Reach
          rows={reach.value}
          elements={sceneElements}
          viewport={viewport}
          onBring={async (imageId) => {
            await api.addSheetImages(sheetInfo.boardId, sheetId, {
              imageIds: [imageId],
            });
            reach.refresh();
          }}
        />
        <button
          ref={inspectorToggleRef}
          type="button"
          className="sheet-mobile-inspector-toggle"
          aria-controls="sheet-inspector-panel"
          aria-expanded={mobileInspectorOpen}
          onClick={() => setMobileInspectorOpen((open) => !open)}
        >
          <Icon name="settings" size={18} />
          <span>Details</span>
        </button>
        {webRoots && sheetInfo && (
          <WebView
            boardId={sheetInfo.boardId}
            sort={sortId(DEFAULT_SORT)}
            roots={webRoots}
            onShowOnBoard={(imageId) =>
              navigate(`/b/${sheetInfo.boardId}?image=${imageId}`)
            }
            onClose={() => setWebRoots(null)}
          />
        )}
        {/* What a screen reader hears when the selection changes. A live
            region speaks only when its words change, so this is said once
            per selection, never mid-gesture (announce.ts). */}
        <output className="visually-hidden" data-testid="announcer">
          {describeSelection(
            selected?.kind === 'own'
              ? selected.elements.map((el) => el.id)
              : [],
            sceneElements,
            (imageId) =>
              sheetInfo.images.find((img) => img.id === imageId)?.name ??
              'a picture',
          )}
        </output>
        {working && (
          <output className="sheet-working" data-testid="sheet-working">
            {working}
          </output>
        )}
        {comparing && (
          <Compare
            a={comparing.a}
            b={comparing.b}
            title={comparing.title}
            onClose={() => setComparing(null)}
          />
        )}
        {menu && (
          <ContextMenu
            x={menu.x}
            y={menu.y}
            sections={menu.sections}
            testId="sheet-context-menu"
            label="Sheet actions"
            onClose={() => setMenu(null)}
          />
        )}
        <Toolbar
          help={help}
          onHelp={setHelp}
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
          relations: connectionRelations,
          connectionRelation,
          onConnectionRelationChange: setConnectionRelation,
          onExportReport: () => void exportReport(),
        }}
        dangling={tools.getDangling()}
        onRemoveDangling={() => tools.removeDangling()}
        inspector={{
          selected,
          elements: sceneElements,
          foreign: foreign.rows,
          sheetName: sheetInfo.name,
          labelTerms,
          relationTerms,
          relationAliases: vocab.vocabulary.aliases.relation,
          imageSrc: (imageId) =>
            files.get(fileId(imageId))?.dataURL ?? api.previewUrl(imageId),
          onSetProperty: tools.setProperty,
          onRemoveProperty: tools.removeProperty,
          onSetTermOn: (ids, term) => {
            tools.setTermOn(ids, term);
            rerender();
          },
          onCopyForeign: (fid, choice) => {
            let refused: string | null = null;
            tools.copyForeign(fid, choice, (reason) => {
              refused = reason;
            });
            return refused;
          },
          onDeleteSelected: () => tools.deleteSelected(),
          sheetId,
          userId: session?.user.id ?? null,
          onExtract: (id) => void extractToPicture(id),
          onOpenWeb: setWebRoots,
          looksLike: sheetInfo
            ? {
                boardId: sheetInfo.boardId,
                sort: sortId(DEFAULT_SORT),
                onSheet: new Set(sheetInfo.images.map((img) => img.id)),
                onBring: async (parentImageId, imageId) =>
                  (await actions.bringBeside(parentImageId, imageId))?.id ??
                  null,
                onConnect: (parentImageId, elementId, relation) => {
                  actions.connectFrom(parentImageId, elementId, relation);
                },
              }
            : undefined,
          onCompare: ([a, b], relation) => {
            const end = (e: typeof a): CompareEnd => ({
              src: api.originalUrl(e.imageId),
              name:
                sheetInfo.images.find((img) => img.id === e.imageId)?.name ??
                'Picture',
              label: e.label,
              focus: e.fraction ?? WHOLE,
            });
            setComparing({
              a: end(a),
              b: end(b),
              title: relation || 'Unnamed connection',
            });
          },
          onSelectClaim: (id) => {
            tools.select(id);
            rerender();
          },
        }}
        mobileOpen={mobileInspectorOpen}
        onFocusToggle={focusInspectorToggle}
      />
    </div>
  );
}
