// The map: deck.gl OrthographicView + TileLayer over the server's tile
// pyramid (docs/design.md "web/", `/b/:id`). Imperative deck.gl, matching
// ../../../prototype/board/viewer/src/main.ts's pattern — the tile-index ->
// URL mapping was verified there against deck.gl's tileset-2d source and is
// reused unchanged: deck's {x,y,z} is the server's {z}/{x}/{y} verbatim.
//
// Slice 2 (docs/ux/design.md §7 "Slice 2 — Board + selection"): the
// selection is now a durable object — a set of IMAGE IDS per (board,
// viewer), server-side, via `useSelection` (board/useSelection.ts) — not
// the ranks this file used to keep in a `Set<number>` (the defect §7 names
// first: a rank means a different image once the sort changes). The old
// inline `.board-side` panel moved into the shell's right column
// (shell/RightColumn.tsx); the bottom tray (board/Tray.tsx), the zoom bar
// (board/ZoomControl.tsx) and the right-click/Actions menu
// (board/ContextMenu.tsx) are new. Every new piece of state that affects
// what's drawn still feeds the one `layers` memo/effect below — the
// TileLayer stays the single source of tiles
// (../.claude/rules/ladder-slot-vs-rank.md: "a selection on the map is a
// client overlay").
import {
  Deck,
  type LayersList,
  OrthographicView,
  type PickingInfo,
} from '@deck.gl/core';
import { TileLayer } from '@deck.gl/geo-layers';
import {
  BitmapLayer,
  LineLayer,
  PolygonLayer,
  TextLayer,
} from '@deck.gl/layers';
import {
  type BoardImage,
  type BoardImageWithRank,
  CELL,
  COLS,
  DEFAULT_SORT,
  type FindBoardResponse,
  type FindFilterClause,
  GRID_LAYOUT_VERSION,
  type GetImageResponse,
  type GetNeighbourhoodResponse,
  type MeaningResponse,
  type Properties,
  type PropertyValue,
  SHEET_LIMIT,
  type Section,
  type Sort,
  type SortKey,
  type TermKind,
  cellOf,
  parseSortId,
  rankAtWorld,
  rankOf,
  sortId,
  worldExtent,
} from '@digsite/shared';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { BoardAdministration } from '../board/BoardAdministration.tsx';
import { BoardSheets, useBoardSheets } from '../board/BoardSheets.tsx';
import {
  ContextMenu,
  type MenuItem,
  type MenuSection,
} from '../board/ContextMenu.tsx';
import { Copies } from '../board/Copies.tsx';
import { CopyToBoard } from '../board/CopyToBoard.tsx';
import { Detail } from '../board/Detail.tsx';
import { Explore } from '../board/Explore.tsx';
import { FindPanel } from '../board/FindPanel.tsx';
import { FolderImport } from '../board/FolderImport.tsx';
import { PathPanel } from '../board/PathPanel.tsx';
import { Terms } from '../board/Terms.tsx';
import { Tray } from '../board/Tray.tsx';
import { UploadActivity } from '../board/UploadActivity.tsx';
import { WebView } from '../board/WebView.tsx';
import { ZoomControl, zoomIn, zoomOut } from '../board/ZoomControl.tsx';
import {
  type BoardCamera,
  MAX_TILE_ZOOM,
  MAX_ZOOM,
  MIN_ZOOM,
  type Screen,
  centreOn,
  fitBoard,
  fitRanks,
  zoomTo,
} from '../board/camera.ts';
import { DetailCache, containedRect, visibleRanks } from '../board/detail.ts';
import { rankWindow, useFind } from '../board/find.ts';
import { outlinesOf, pointedAt, useBoardPresence } from '../board/presence.ts';
import { RankedView, identity, useRanked } from '../board/ranked-view.ts';
import { sectionMarkers, sectionsVisible } from '../board/sections-layer.ts';
import {
  type Press,
  cellCorner,
  cellPolygon,
  pressMove,
} from '../board/selection.ts';
import {
  enqueueUploads,
  getUploadSnapshot,
  subscribeUploadQueue,
} from '../board/upload.ts';
import { useSelection } from '../board/useSelection.ts';
import { Compare, type CompareEnd } from '../components/Compare.tsx';
import { WHOLE } from '../components/compare-view.ts';
import { modalOpen } from '../lib/modal.ts';
import { noteOrderVersion, waitForOrderVersion } from '../lib/order-version.ts';
import '../board/board.css';
import type { GetBoardResponse } from '@digsite/shared/api';
import { Confirm } from '../components/Confirm.tsx';
import {
  ErrorState,
  type ErrorStateInfo,
  fromCaught,
} from '../components/ErrorState.tsx';
import { Icon } from '../components/Icon.tsx';
import { RenameInline } from '../components/RenameInline.tsx';
import { ApiError, api } from '../lib/api.ts';
import { plural } from '../lib/plural.ts';
import { notifySheetsChanged } from '../lib/sheetEvents.ts';
import { useVocabulary } from '../lib/vocabulary.ts';
import { useRightColumn } from '../shell/RightColumn.tsx';
import { rgba, usePalette } from '../theme/palette.ts';

declare global {
  interface Window {
    __digsiteBoard?: {
      setZoom: (z: number) => void;
      // Ranks, not ids — the debug surface stays rank-shaped (every
      // existing smoke script reads/writes it that way) even though the
      // selection itself is id-shaped underneath; ranks are resolved
      // against the CURRENT sort at call time.
      getSelection: () => number[];
      select: (rank: number) => void;
      selectRange: (a: number, b: number) => void;
      clear: () => void;
      /** By id, for a walk that knows which pictures it means. */
      selectIds: (ids: string[]) => void;
      getLayerIds: () => string[];
      getCamera: () => {
        target: [number, number, number];
        zoom: number;
      } | null;
      goToRank: (rank: number) => void;
      // Phase 2 section 4 (docs/phases/2-sheet.md): Explore.tsx's
      // "the result becomes the map selection" — resolves ranks through
      // ONE `GET /boards/:id/images?ids=` call (lib/api.ts's
      // `getBoardImagesByIds`).
      selectImages: (ids: string[], mode?: 'replace' | 'add') => void;
    };
  }
}

const TILE_SIZE = 256;

interface Status {
  zoom: number;
  tilesRequested: number;
  cacheHits: number;
  cacheTotal: number;
  ttftMs: number | null;
}

interface HoverTooltip {
  x: number;
  y: number;
  rank: number;
  image: BoardImage;
}

interface OpenContextMenu {
  x: number;
  y: number;
  sections: MenuSection[];
}

function storageKey(boardId: string): string {
  return `digsite:sort:${boardId}`;
}

/** The server's cap on one download, and how many ids go in its URL
 * before the stored selection stands in for them. */
const DOWNLOAD_MAX = 500;
const DOWNLOAD_BY_IDS = 150;
const NO_SECTIONS: Section[] = [];
const NO_BITMAPS: ReadonlyMap<string, ImageBitmap> = new Map();
/** The first rank each visible-cells reply answers for. */
const cellsStart = new WeakMap<object, number>();
const NO_IMAGES: BoardImageWithRank[] = [];
const NO_RANKS: number[] = [];
const NO_IDS: ReadonlySet<string> = new Set();

/** Per-sort cache of rank -> image (or null for an empty/failed lookup),
 * shared between hover and rank-resolving selection ops so a rank fetched
 * once is never re-fetched. */
function sortCache(
  store: Map<string, Map<number, BoardImage | null>>,
  sort: string,
): Map<number, BoardImage | null> {
  let c = store.get(sort);
  if (!c) {
    c = new Map();
    store.set(sort, c);
  }
  return c;
}

function isTextInput(el: EventTarget | null): boolean {
  const tag = (el as HTMLElement | null)?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export function Board() {
  const palette = usePalette();
  const { id } = useParams<{ id: string }>();
  const boardId = id ?? '';
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const selection = useSelection(boardId);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const deckRef = useRef<Deck<OrthographicView> | null>(null);
  const viewStateRef = useRef<BoardCamera | null>(null);
  const statusRef = useRef<Status>({
    zoom: 0,
    tilesRequested: 0,
    cacheHits: 0,
    cacheTotal: 0,
    ttftMs: null,
  });
  const sortChangeAt = useRef(performance.now());
  // `board` read from inside Deck's event closures (built once, on mount)
  // would otherwise be stale; those read this ref instead.
  const boardRef = useRef<GetBoardResponse | null>(null);

  const [board, setBoard] = useState<GetBoardResponse | null>(null);
  boardRef.current = board;
  const [boardError, setBoardError] = useState<ErrorStateInfo | null>(null);
  const [sort, setSort] = useState<Sort>(DEFAULT_SORT);
  const [tileVersion, setTileVersion] = useState(0);
  const [folderImport, setFolderImport] = useState(false);
  /** The pictures being copied to another board, while its dialog is open. */
  const [copying, setCopying] = useState<string[] | null>(null);
  const currentSortId = sort ? sortId(sort) : DEFAULT_SORT.key.toString();
  /** Every answer this page holds in ranks, under the build the map shows
   * (board/ranked-view.ts). One per board and sort. */
  const view = useMemo(
    () => new RankedView(boardId, currentSortId),
    [boardId, currentSortId],
  );
  useEffect(() => () => view.dispose(), [view]);
  const viewRef = useRef(view);
  viewRef.current = view;
  const [comparing, setComparing] = useState<[CompareEnd, CompareEnd] | null>(
    null,
  );
  /** "How are these two connected?": the two ends, and the chain found. */
  const [pathEnds, setPathEnds] = useState<
    [{ id: string; name: string }, { id: string; name: string }] | null
  >(null);
  const [pathImages, setPathImages] = useState<BoardImageWithRank[]>([]);
  /** The web view's starting pictures, while it is open, and the relation
   * it shows when it is the web of one relation. */
  const [webRoots, setWebRoots] = useState<string[] | null>(null);
  const [webRelation, setWebRelation] = useState<string | undefined>();
  const [fileDragActive, setFileDragActive] = useState(false);
  const [, forceRender] = useState(0);

  // -- the camera (board/camera.ts decides where; these only write it) -----
  /** A camera deck already shows (its own pan or zoom, or the first fit):
   * the ref the page reads and the zoom readout. */
  const noteView = useCallback((next: BoardCamera) => {
    viewStateRef.current = next;
    statusRef.current.zoom = next.zoom;
    forceRender((n) => n + 1);
  }, []);
  /** Moves the map. The one place the page hands deck a camera. */
  const setView = useCallback(
    (next: BoardCamera) => {
      noteView(next);
      deckRef.current?.setProps({ viewState: next });
    },
    [noteView],
  );
  /** Moves the map from where it is; no move before deck has mounted, or
   * when `f` has nowhere to go. */
  const moveView = useCallback(
    (f: (camera: BoardCamera) => BoardCamera | null) => {
      const now = viewStateRef.current;
      const next = deckRef.current && now ? f(now) : null;
      if (next) setView(next);
    },
    [setView],
  );
  const screenSize = useCallback((): Screen => {
    const rect = canvasRef.current?.getBoundingClientRect();
    return {
      width: rect?.width || window.innerWidth,
      height: rect?.height || window.innerHeight - 200,
    };
  }, []);

  // -- sections --------------------------------------------------------------
  const sectionsAnswer = useRanked(view, board ? 'sections' : null, () =>
    api.getSections(boardId, currentSortId),
  );
  // Without sections the map still works, just without labels.
  const sections = sectionsAnswer?.value?.sections ?? NO_SECTIONS;
  const sectionsTruncated = sectionsAnswer?.value?.truncated ?? false;
  const sectionsRef = useRef<Section[]>([]);
  sectionsRef.current = sections;

  // -- hover -------------------------------------------------------------------
  const hoverTimerRef = useRef<number | null>(null);
  const imageCacheRef = useRef<Map<string, Map<number, BoardImage | null>>>(
    new Map(),
  );
  const [hoverTooltip, setHoverTooltip] = useState<HoverTooltip | null>(null);

  // -- selection: resolved images (order preserved by the server —
  // lib/api.ts's getBoardImagesByIds) --------------------------------------
  // Resolved with each image's rank under the current sort; the tray, the
  // map outline, fly-to and window.__digsiteBoard.getSelection() read it.
  const selectionAnswer = useRanked(
    view,
    selection.imageIds.length ? selection.imageIds.join(',') : null,
    () => api.getBoardImagesByIds(boardId, currentSortId, selection.imageIds),
  );
  /** Images this page has just marked missing, before the next answer. */
  const [markedMissing, setMarkedMissing] =
    useState<ReadonlySet<string>>(NO_IDS);
  const selectedImages = useMemo(() => {
    const found = selectionAnswer?.value?.images ?? NO_IMAGES;
    return markedMissing.size
      ? found.map((i) =>
          markedMissing.has(i.id) ? { ...i, missing: true } : i,
        )
      : found;
  }, [selectionAnswer, markedMissing]);
  const selectedImagesRef = useRef<BoardImageWithRank[]>([]);
  selectedImagesRef.current = selectedImages;
  const [selectionNote, setSelectionNote] = useState('');
  const [findOpen, setFindOpen] = useState(false);
  /** The focused image's neighbourhood (board/Explore.tsx), and where its
   * images sit under the current sort, for the lines on the map. */
  const [exploreGraph, setExploreGraph] =
    useState<GetNeighbourhoodResponse | null>(null);
  const vocab = useVocabulary(boardId);
  const lastClickRankRef = useRef<number | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);

  // -- focus: which image's detail/Explore the right column shows. Auto-set
  // whenever the selection narrows to exactly one image; otherwise it's
  // whatever the owner last clicked in the tray (board/Tray.tsx onClickItem)
  // — the same click flies the map to that cell. -----------------------------
  const [focusedImageId, setFocusedImageId] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reacts BY selectedImages changing; focusedImageId is read, not a trigger
  useEffect(() => {
    if (selectedImages.length === 1 && selectedImages[0]) {
      setFocusedImageId(selectedImages[0].id);
    } else if (
      focusedImageId &&
      !selectedImages.some((i) => i.id === focusedImageId)
    ) {
      setFocusedImageId(null);
    }
  }, [selectedImages]);

  // -- detail ------------------------------------------------------------------
  const [detailImage, setDetailImage] = useState<GetImageResponse | null>(null);
  const [detailSaveState, setDetailSaveState] = useState<
    'idle' | 'saving' | 'saved' | 'error'
  >('idle');

  // -- context menu --------------------------------------------------------
  const [contextMenu, setContextMenu] = useState<OpenContextMenu | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const [startSheetRequested, setStartSheetRequested] = useState(false);
  const [addSheetRequested, setAddSheetRequested] = useState(false);

  // -- upload ------------------------------------------------------------------
  const uploadSnapshot = useSyncExternalStore(
    (listener) => subscribeUploadQueue(boardId, listener),
    () => getUploadSnapshot(boardId),
    () => getUploadSnapshot(boardId),
  );
  const uploadSnapshotRef = useRef(uploadSnapshot);
  uploadSnapshotRef.current = uploadSnapshot;
  const uploading =
    uploadSnapshot.counts.queued > 0 || uploadSnapshot.counts.uploading > 0;
  const lastUploadRefreshRef = useRef(Date.now());
  const uploadRefreshTimerRef = useRef<number | null>(null);
  const uploadRefreshTimerBoardRef = useRef('');
  const currentBoardIdRef = useRef(boardId);
  const handledUploadVersionsRef = useRef(
    new Map<string, { board: number; tiles: number }>(),
  );
  currentBoardIdRef.current = boardId;

  useEffect(() => {
    if (!uploadSnapshot.refreshVersion && !uploadSnapshot.tileRefreshVersion)
      return;
    if (
      uploadRefreshTimerRef.current !== null &&
      uploadRefreshTimerBoardRef.current === boardId
    ) {
      return;
    }
    if (uploadRefreshTimerRef.current !== null) {
      window.clearTimeout(uploadRefreshTimerRef.current);
    }
    const elapsed = Date.now() - lastUploadRefreshRef.current;
    const delay = Math.max(250, 1200 - elapsed);
    uploadRefreshTimerBoardRef.current = boardId;
    uploadRefreshTimerRef.current = window.setTimeout(() => {
      uploadRefreshTimerRef.current = null;
      const targetBoardId = uploadRefreshTimerBoardRef.current;
      if (currentBoardIdRef.current !== targetBoardId) return;
      const latest = uploadSnapshotRef.current;
      if (latest.boardId !== targetBoardId) return;
      const handled = handledUploadVersionsRef.current.get(targetBoardId) ?? {
        board: 0,
        tiles: 0,
      };
      const refreshBoard = latest.refreshVersion > handled.board;
      const refreshTiles = latest.tileRefreshVersion > handled.tiles;
      handledUploadVersionsRef.current.set(targetBoardId, {
        board: latest.refreshVersion,
        tiles: latest.tileRefreshVersion,
      });
      lastUploadRefreshRef.current = Date.now();
      if (refreshTiles) setTileVersion((value) => value + 1);
      if (refreshBoard) {
        void api
          .getBoard(targetBoardId)
          .then((fresh) => {
            if (currentBoardIdRef.current === targetBoardId) setBoard(fresh);
          })
          .catch(() => {});
      }
    }, delay);
  }, [
    boardId,
    uploadSnapshot.refreshVersion,
    uploadSnapshot.tileRefreshVersion,
  ]);

  useEffect(
    () => () => {
      if (uploadRefreshTimerRef.current !== null) {
        window.clearTimeout(uploadRefreshTimerRef.current);
        uploadRefreshTimerRef.current = null;
      }
    },
    [],
  );

  // -- sheets (board/BoardSheets.tsx): the right column lists them, the
  // tray adds to them.
  const sheets = useBoardSheets(boardId);

  // -- load the board, then the viewer's stored or default sort ------------
  // docs/ux/audit.md #1: a board the viewer can't or shouldn't see (bad id,
  // private and not on the allowlist, wrong group) used to hang on
  // "loading…" forever — this call had no `.catch()` at all.
  useEffect(() => {
    let cancelled = false;
    setBoardError(null);
    api
      .getBoard(boardId)
      .then((b) => {
        if (cancelled) return;
        setBoard(b);
        const stored = localStorage.getItem(storageKey(boardId));
        const parsed =
          (stored && parseSortId(stored)) || parseSortId(b.defaultSort);
        setSort(parsed ?? DEFAULT_SORT);
      })
      .catch((err) => {
        if (cancelled) return;
        setBoardError(fromCaught(err, 'board'));
      });
    return () => {
      cancelled = true;
    };
  }, [boardId]);

  // -- 10s loading timeout -> the same error shape (docs/ux/design.md §4.10:
  // "Every loading state that can hang... gets a 10s timeout"). ------------
  useEffect(() => {
    if (board || boardError) return;
    const t = window.setTimeout(() => {
      setBoardError({
        status: 500,
        resource: 'board',
        reason: 'This is taking longer than expected.',
      });
    }, 10_000);
    return () => window.clearTimeout(t);
  }, [board, boardError]);

  // -- board rename: a refusal shows beside the name (RenameInline) ------
  async function renameBoard(name: string) {
    const res = await api.renameBoard(boardId, { name });
    setBoard((prev) => (prev ? { ...prev, name: res.name } : prev));
  }

  // Refs, not the values themselves: `window.__digsiteBoard` is assigned
  // once with an empty dependency array (see that effect's own comment —
  // every function there closes over refs or the selection hook's own
  // STABLE function identities, never a piece of state directly, so it
  // never goes stale).
  const boardIdRef = useRef(boardId);
  boardIdRef.current = boardId;
  const currentSortIdRef = useRef(currentSortId);
  currentSortIdRef.current = currentSortId;

  function changeSort(next: Sort) {
    setSort(next);
    localStorage.setItem(storageKey(boardId), sortId(next));
  }

  // -- resolve the image at a rank under the CURRENT sort, caching per sort --
  const resolveImageAtRank = useCallback(async (rank: number) => {
    const b = boardRef.current;
    if (!b || rank < 0 || rank >= b.imageCount) return null;
    const cache = sortCache(imageCacheRef.current, currentSortIdRef.current);
    const cached = cache.get(rank);
    if (cached !== undefined) return cached;
    try {
      const { images } = await api.listBoardImages(
        boardIdRef.current,
        currentSortIdRef.current,
        rank,
        1,
      );
      const img = images[0] ?? null;
      cache.set(rank, img);
      return img;
    } catch {
      return null;
    }
  }, []);

  // -- a shift+click / band drag range, resolved SERVER-SIDE (design.md
  // §5.1: "Range and band selects resolve server-side... a million-cell
  // board never pages ranks to the client"). -------------------------------
  const rangeSelect = useCallback(
    async (a: number, b: number, mode?: 'band') => {
      try {
        const v = viewRef.current.build;
        const { imageIds } = await api.postSelectionRange(boardIdRef.current, {
          sort: currentSortIdRef.current,
          fromRank: a,
          toRank: b,
          ...(mode ? { mode } : {}),
          // The ranks were read under this build; if the order moved on,
          // the server selects nothing rather than other pictures.
          ...(v ? { v } : {}),
        });
        selection.add(imageIds);
        const span =
          mode === 'band'
            ? (Math.abs((a % COLS) - (b % COLS)) + 1) *
              (Math.abs(Math.floor(a / COLS) - Math.floor(b / COLS)) + 1)
            : Math.abs(b - a) + 1;
        setSelectionNote(
          imageIds.length > 0 && imageIds.length < span
            ? `Selection capped at ${plural(imageIds.length, 'image')}`
            : '',
        );
      } catch (err) {
        if (err instanceof ApiError && err.status === 409)
          setSelectionNote(
            'The map changed while you selected, so nothing was selected. Select again on the new map.',
          );
        // otherwise the range endpoint was unreachable; nothing selected
      }
    },
    [selection],
  );

  const sectionSelect = useCallback(
    (section: Section) => void rangeSelect(section.fromRank, section.toRank),
    [rangeSelect],
  );

  // -- deck.gl mount, once ---------------------------------------------------
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberately mount-once; handleClick/handleHover/rangeSelect close over refs and the selection hook's stable functions, never stale
  useEffect(() => {
    if (!canvasRef.current || !board) return;
    if (deckRef.current) return;
    // deck.gl's onViewStateChange (below) only fires on a user-driven
    // change, never for the `initialViewState` passed at construction, so
    // the fit is noted here or the zoom readout starts at 0 and "zoom in"
    // reads as already at its limit.
    noteView(fitBoard(board.imageCount, screenSize()));
    deckRef.current = new Deck({
      canvas: canvasRef.current,
      views: new OrthographicView({ id: 'board' }),
      initialViewState: viewStateRef.current,
      controller: true,
      layers: [],
      onViewStateChange: ({ viewState }) => noteView(viewState as BoardCamera),
      onClick: (info, event) => handleClick(info, event),
      onHover: (info) => handleHover(info),
      onDragStart: (info, event) => {
        if (!shiftHeldRef.current || !boardRef.current || !info.coordinate)
          return;
        const [wx, wy] = info.coordinate as [number, number];
        const startRank = rankAtWorld(wx, wy);
        if (startRank < 0) return;
        shiftDragRef.current = { startRank };
        event.srcEvent?.preventDefault?.();
      },
      onDragEnd: (info) => {
        const drag = shiftDragRef.current;
        shiftDragRef.current = null;
        if (!drag || !info.coordinate) return;
        const [wx, wy] = info.coordinate as [number, number];
        const col = Math.floor(
          Math.max(0, Math.min(wx, COLS * CELL - 0.001)) / CELL,
        );
        const row = Math.floor(Math.max(0, wy) / CELL);
        const endRank = rankOf(col, row);
        void rangeSelect(drag.startRank, endRank, 'band');
      },
    });
    return () => {
      deckRef.current?.finalize();
      deckRef.current = null;
    };
  }, [board?.id]);

  // -- "Show on board" (design.md §5.1: a sheet's own top bar returns here
  // with the sheet's images selected, the map scrolled to the first) — a
  // `?showSheet=<id>` query param, consumed once and stripped from the URL.
  // Only meant to re-run when the BOARD loads/changes — `searchParams`/
  // `setSearchParams` are read and written, not reacted to; including them
  // would re-fire this on every OTHER query-param change too.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
  useEffect(() => {
    if (!board) return;
    const sheetIdParam = searchParams.get('showSheet');
    // `?image=<id>`: a link to one picture on the board. The map flies to
    // it and its details open; the selection is left alone.
    const imageParam = searchParams.get('image');
    if (!sheetIdParam && !imageParam) return;
    if (sheetIdParam) void showSheetOnBoard(sheetIdParam);
    if (imageParam) void showImageById(imageParam);
    const next = new URLSearchParams(searchParams);
    next.delete('showSheet');
    next.delete('image');
    setSearchParams(next, { replace: true });
  }, [board]);

  async function showImageById(imageId: string) {
    try {
      const { images: found } = await api.getBoardImagesByIds(
        boardId,
        currentSortId,
        [imageId],
      );
      const img = found[0];
      if (!img) return;
      if (typeof img.rank === 'number') showOnMap(img.id, img.rank);
      else setFocusedImageId(img.id);
    } catch {
      // not on this board, or not visible to this viewer: nothing to show
    }
  }

  async function showSheetOnBoard(sheetIdParam: string) {
    try {
      const sheet = await api.getSheet(sheetIdParam);
      const ids = sheet.images.map((i) => i.id);
      selection.replace(ids);
      const first = ids[0];
      if (!first || !deckRef.current) return;
      const { images: found } = await api.getBoardImagesByIds(
        boardId,
        currentSortId,
        [first],
      );
      const firstImg = found[0];
      if (firstImg && typeof firstImg.rank === 'number') {
        moveView((cam) => centreOn(cam, firstImg.rank as number));
      }
    } catch {
      // sheet unreachable this tick; nothing selected
    }
  }

  // -- shift toggles the controller's drag-to-pan off, so a shift-drag can
  // become a range selection instead of a pan. Set proactively on keydown,
  // before the gesture starts, so there's no race with the first pan tick. --
  const shiftHeldRef = useRef(false);
  const shiftDragRef = useRef<{ startRank: number } | null>(null);
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Shift' || shiftHeldRef.current) return;
      shiftHeldRef.current = true;
      deckRef.current?.setProps({ controller: { dragPan: false } });
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.key !== 'Shift') return;
      shiftHeldRef.current = false;
      deckRef.current?.setProps({ controller: true });
    }
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  // -- Escape closes the detail panel; Ctrl/Cmd+Z undoes/redoes the
  // SELECTION only (design.md §5.1: "nothing else on the board is
  // undoable"), skipped while a text field has focus so it doesn't fight
  // an input's own undo. -----------------------------------------------------
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (modalOpen()) return;
      if (e.key === 'Escape') {
        setDetailImage(null);
        setContextMenu(null);
        return;
      }
      if (isTextInput(e.target)) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) selection.redo();
        else selection.undo();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selection]);

  // A debug-only hook for the smoke script's screenshots — NOT part of the
  // fixed window.__digsite contract (that is sheet-only, see sheet/tools.ts).
  // Assigned once: every function here closes over refs, or the selection
  // hook's stable function identities (useSelection.ts: `commit`'s deps
  // never change, so `toggle`/`replace`/`add`/`clear` are stable across
  // renders) — never a piece of state read directly — so it never goes
  // stale despite the empty dependency array.
  useEffect(() => {
    window.__digsiteBoard = {
      setZoom: (z: number) => moveView((cam) => zoomTo(cam, z)),
      getSelection: () =>
        selectedImagesRef.current
          .map((i) => i.rank)
          .filter((r): r is number => typeof r === 'number')
          .sort((a, b) => a - b),
      select: (rank: number) => {
        void resolveImageAtRank(rank).then((img) => {
          if (img) selection.toggle(img.id);
        });
      },
      selectRange: (a: number, b: number) => void rangeSelect(a, b),
      clear: () => selection.clear(),
      selectIds: (ids: string[]) => selection.replace(ids),
      getLayerIds: () =>
        ((deckRef.current?.props.layers ?? []) as { id?: string }[])
          .map((l) => l?.id)
          .filter((x): x is string => !!x),
      getCamera: () => {
        const view = viewStateRef.current;
        const [x, y, z = 0] = view?.target ?? [0, 0, 0];
        return view
          ? {
              target: [x, y, z],
              zoom: view.zoom as number,
            }
          : null;
      },
      goToRank: (rank: number) => moveView((cam) => centreOn(cam, rank)),
      selectImages: (ids: string[], mode: 'replace' | 'add' = 'replace') => {
        if (mode === 'add') selection.add(ids);
        else selection.replace(ids);
      },
    };
  }, [resolveImageAtRank, rangeSelect, selection, moveView]);

  // -- the order build the map shows ----------------------------------------
  // A newer build: the tiles and the rank-to-image cache were drawn under
  // the old one. The view itself asks every answer in ranks again.
  useEffect(() => {
    setHoverTooltip(null);
    return view.onMove(() => {
      for (const cache of imageCacheRef.current.values()) cache.clear();
      setTileVersion((n) => n + 1);
      setHoverTooltip(null);
    });
  }, [view]);

  // Find: a question in, an answer in ranks out (board/find.ts). An alias
  // merge changes what a term matches, so it asks again.
  // The ranks on screen, so a find dims every match the map shows.
  const findBox = canvasRef.current?.getBoundingClientRect();
  const findView = viewStateRef.current;
  const onScreen =
    findView && findBox && board
      ? rankWindow(
          {
            target: findView.target as number[],
            zoom: findView.zoom as number,
          },
          findBox.height,
          board.imageCount,
        )
      : null;
  const finder = useFind(view, findOpen, vocab.vocabulary.aliases, onScreen);
  const findResult = finder.result;

  // -- presence: who else is here, and what they point at (presence.ts) ----
  const presence = useBoardPresence(
    boardId,
    hoverTooltip?.image.id ?? null,
    selection.imageIds,
  );
  const pointed = pointedAt(presence.viewers);
  const pointedAnswer = useRanked(
    view,
    pointed.length ? `presence ${pointed.join(',')}` : null,
    () => api.getBoardImagesByIds(boardId, currentSortId, pointed),
  );
  const outlines = useMemo(() => {
    const rankOf = new Map<string, number>();
    for (const img of pointedAnswer?.value?.images ?? [])
      if (typeof img.rank === 'number') rankOf.set(img.id, img.rank);
    return outlinesOf(presence.viewers, rankOf);
  }, [presence.viewers, pointedAnswer]);
  const othersHere = useMemo(() => {
    const byPerson = new Map<string, { name: string; colour: string }>();
    for (const v of presence.viewers)
      if (!byPerson.has(v.id))
        byPerson.set(v.id, { name: v.name, colour: v.colour });
    return [...byPerson.values()];
  }, [presence.viewers]);

  // Where the neighbourhood's images sit on the map under this sort.
  const exploreAnswer = useRanked(
    view,
    exploreGraph ? exploreGraph.images.map((i) => i.id).join(',') : null,
    () =>
      api.getBoardImagesByIds(
        boardId,
        currentSortId,
        exploreGraph?.images.map((i) => i.id) ?? [],
      ),
  );
  const exploreRanks = useMemo(() => {
    const ranks = new Map<string, number>();
    for (const img of exploreAnswer?.value?.images ?? [])
      if (typeof img.rank === 'number') ranks.set(img.id, img.rank);
    return ranks;
  }, [exploreAnswer]);

  // Ranks of images any sheet has annotated, for the corner marks. Asked
  // again when the vocabulary changes, which is when some sheet's claims did.
  const annotatedAnswer = useRanked(
    view,
    `annotated ${identity(vocab.vocabulary)}`,
    () => api.findBoard(boardId, currentSortId, '', [], { annotated: true }),
  );
  const annotatedRanks = annotatedAnswer?.value?.ranks ?? NO_RANKS;

  // -- fetch the tile ----------------------------------------------------------
  const fetchTile = useCallback(
    async (
      index: { x: number; y: number; z: number },
      signal?: AbortSignal,
    ) => {
      // The build the map shows; the first tiles of a visit wait a moment
      // for it, so they can be asked for as cacheable (order-version.ts).
      const v = await waitForOrderVersion(boardId, currentSortId, 1500);
      const url = api.tileUrl(
        boardId,
        currentSortId,
        index.z,
        index.x,
        index.y,
        v,
      );
      statusRef.current.tilesRequested++;
      forceRender((n) => n + 1);
      const res = await fetch(url, {
        credentials: 'include',
        signal,
        // With `v` the browser's cache is right by construction; without
        // it, a tile must be read fresh.
        cache: v ? 'default' : 'reload',
      });
      const token = res.headers.get('X-Order-Version');
      if (token) noteOrderVersion(boardId, currentSortId, token);
      if (!res.ok) throw new Error(`tile fetch failed: ${res.status}`);
      const xCache = res.headers.get('X-Cache');
      statusRef.current.cacheTotal++;
      if (xCache === 'hit') statusRef.current.cacheHits++;
      const blob = await res.blob();
      const bitmap = await createImageBitmap(blob);
      if (statusRef.current.ttftMs === null) {
        statusRef.current.ttftMs = performance.now() - sortChangeAt.current;
      }
      forceRender((n) => n + 1);
      return bitmap;
    },
    [boardId, currentSortId],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset is triggered BY a sort/tile-version change, not by reading them
  useEffect(() => {
    sortChangeAt.current = performance.now();
    statusRef.current = {
      ...statusRef.current,
      tilesRequested: 0,
      cacheHits: 0,
      cacheTotal: 0,
      ttftMs: null,
    };
  }, [currentSortId, tileVersion]);

  // -- detail: past the tiles, each visible cell draws its own preview ------
  /** The previews loaded so far, as the cache last published them. */
  const [detailBitmaps, setDetailBitmaps] =
    useState<ReadonlyMap<string, ImageBitmap>>(NO_BITMAPS);
  const detailCacheRef = useRef<DetailCache | null>(null);
  if (!detailCacheRef.current)
    detailCacheRef.current = new DetailCache(async (imageId) => {
      const res = await fetch(api.previewUrl(imageId), {
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`preview failed: ${res.status}`);
      return createImageBitmap(await res.blob());
    }, setDetailBitmaps);
  useEffect(() => () => detailCacheRef.current?.clear(), []);
  const detailView = viewStateRef.current;
  const detailBox = canvasRef.current?.getBoundingClientRect();
  const detailKey =
    detailView && detailBox && board
      ? visibleRanks(
          {
            target: detailView.target as number[],
            zoom: detailView.zoom as number,
          },
          detailBox.width,
          detailBox.height,
          board.imageCount,
        ).join(',')
      : '';
  // Which image each visible cell holds: one request for the whole view,
  // an answer in ranks like any other (ranked-view.ts).
  const detailRanks = detailKey ? detailKey.split(',').map(Number) : [];
  const detailFrom = detailRanks.length ? Math.min(...detailRanks) : 0;
  const detailTo = detailRanks.length ? Math.max(...detailRanks) : -1;
  const cellsAnswer = useRanked(
    view,
    detailRanks.length ? `cells ${detailFrom}-${detailTo}` : null,
    () => {
      // The answer held while a newer one is asked belongs to an older
      // view, so each reply keeps the rank it starts at. The reply itself
      // is returned: the ranked view reads its build off that object.
      const from = detailFrom;
      return api
        .listBoardImages(boardId, currentSortId, from, detailTo - from + 1)
        .then((reply) => {
          cellsStart.set(reply, from);
          return reply;
        });
    },
    120,
  );
  const detailCells = useMemo(() => {
    const cells = new Map<number, BoardImage>();
    const reply = cellsAnswer?.value;
    const start = reply ? cellsStart.get(reply) : undefined;
    if (reply && start !== undefined)
      reply.images.forEach((img, i) => cells.set(start + i, img));
    return cells;
  }, [cellsAnswer]);

  // -- one layers array: tiles + sections + the selection outline -----------
  const zoom = statusRef.current.zoom;
  useEffect(() => {
    if (!deckRef.current || !board) return;
    const accent = rgba(palette.accent);
    const [, , w, h] = worldExtent(board.imageCount);
    const tileLayer = new TileLayer({
      id: `board-tiles-${currentSortId}-grid-${GRID_LAYOUT_VERSION}`,
      data: null,
      tileSize: TILE_SIZE,
      extent: [0, 0, w, h],
      minZoom: MIN_ZOOM,
      maxZoom: MAX_TILE_ZOOM,
      refinementStrategy: 'never',
      // Updating already visible cells must not replace the whole layer.
      // TileLayer reloads selected tiles for a changed getTileData trigger
      // while retaining their previous bitmap until the replacement arrives.
      updateTriggers: {
        getTileData: tileVersion,
      },
      getTileData: ({ index, signal }) => fetchTile(index, signal),
      renderSubLayers: (props) => {
        if (!props.data) return null;
        const [[left, top], [right, bottom]] = props.tile.boundingBox as [
          [number, number],
          [number, number],
        ];
        return new BitmapLayer(props, {
          data: undefined,
          image: props.data as ImageBitmap,
          bounds: [left, bottom, right, top],
        });
      },
    });

    const list: LayersList = [tileLayer];

    // Over the stretched tiles, the pictures themselves (board/detail.ts).
    if (detailKey) {
      for (const rank of detailKey.split(',').map(Number)) {
        const img = detailCells.get(rank);
        if (!img || img.status !== 'ready' || img.missing) continue;
        const bitmap = detailBitmaps.get(img.id);
        if (!bitmap) {
          detailCacheRef.current?.want(img.id);
          continue;
        }
        const r = containedRect(rank, img.width, img.height);
        list.push(
          new BitmapLayer({
            id: `detail-${img.id}`,
            image: bitmap,
            bounds: [r.x, r.y + r.height, r.x + r.width, r.y],
          }),
        );
      }
    }

    if (findResult && finder.dimmed.length) {
      list.push(
        new PolygonLayer({
          id: 'find-matches',
          data: finder.dimmed.map((rank, order) => ({
            polygon: cellPolygon(rank),
            order,
          })),
          getPolygon: (d) => d.polygon,
          stroked: false,
          filled: true,
          // Best first: the closest matches stand out, the tail fades.
          getFillColor: (d) =>
            rgba(
              palette.accent,
              findResult.ranked
                ? Math.round(120 - 90 * Math.min(1, d.order / 40))
                : 56,
            ),
          updateTriggers: { getFillColor: [findResult.ranked, palette.accent] },
        }),
      );
    }

    // The match being looked at, outlined so the eye finds it after the fly.
    const lookingAt = findResult?.imageIds.indexOf(focusedImageId ?? '') ?? -1;
    const lookingRank =
      lookingAt >= 0 ? findResult?.ranks[lookingAt] : undefined;
    if (lookingRank !== undefined) {
      list.push(
        new PolygonLayer({
          id: 'find-looking-at',
          data: [cellPolygon(lookingRank)],
          getPolygon: (d) => d,
          stroked: true,
          filled: false,
          getLineColor: rgba(palette.accent),
          getLineWidth: 3,
          lineWidthUnits: 'pixels',
        }),
      );
    }

    if (sections.length && sectionsVisible(zoom)) {
      const markers = sectionMarkers(sections);
      list.push(
        new LineLayer({
          id: 'sections-line',
          data: markers,
          getSourcePosition: (d) => d.lineStart,
          getTargetPosition: (d) => d.lineEnd,
          getColor: rgba(palette.lineStrong, 200),
          getWidth: 1,
          widthUnits: 'pixels',
        }),
      );
      list.push(
        new TextLayer({
          id: 'sections-text',
          data: markers,
          getPosition: (d) => d.textPosition,
          getText: (d) => d.label,
          getSize: 12,
          sizeUnits: 'pixels',
          getColor: rgba(palette.textPrimary, 235),
          getTextAnchor: 'start',
          getAlignmentBaseline: 'top',
          getPixelOffset: [3, 2],
          billboard: false,
        }),
      );
    }

    // The focused image's connections, drawn between the cells they join.
    if (exploreGraph && exploreRanks.size > 1) {
      const centre = (rank: number): [number, number] => {
        const { col, row } = cellOf(rank);
        return [col * CELL + CELL / 2, row * CELL + CELL / 2];
      };
      const segments = exploreGraph.edges.flatMap((e) => {
        const a = exploreRanks.get(e.source.imageId);
        const b = exploreRanks.get(e.target.imageId);
        return a === undefined || b === undefined
          ? []
          : [{ from: centre(a), to: centre(b) }];
      });
      list.push(
        new PolygonLayer({
          id: 'explore-cells',
          data: [...exploreRanks.values()],
          getPolygon: (rank: number) => cellPolygon(rank),
          stroked: true,
          filled: false,
          getLineColor: rgba(palette.claimEdge, 200),
          getLineWidth: 1.5,
          lineWidthUnits: 'pixels',
        }),
        new LineLayer({
          id: 'explore-lines',
          data: segments,
          getSourcePosition: (d: { from: [number, number] }) => d.from,
          getTargetPosition: (d: { to: [number, number] }) => d.to,
          getColor: rgba(palette.claimEdge, 230),
          getWidth: 2,
          widthUnits: 'pixels',
        }),
      );
    }

    // The chain between two pictures, drawn over everything else it crosses.
    const pathRanks = pathImages
      .map((img) => img.rank)
      .filter((rank): rank is number => typeof rank === 'number');
    if (pathRanks.length > 1) {
      const centre = (rank: number): [number, number] => {
        const { col, row } = cellOf(rank);
        return [col * CELL + CELL / 2, row * CELL + CELL / 2];
      };
      list.push(
        new PolygonLayer({
          id: 'path-cells',
          data: pathRanks,
          getPolygon: (rank: number) => cellPolygon(rank),
          stroked: true,
          filled: false,
          getLineColor: rgba(palette.accent),
          getLineWidth: 3,
          lineWidthUnits: 'pixels',
        }),
        new LineLayer({
          id: 'path-lines',
          data: pathRanks.slice(1).map((rank, i) => ({
            from: centre(pathRanks[i] as number),
            to: centre(rank),
          })),
          getSourcePosition: (d: { from: [number, number] }) => d.from,
          getTargetPosition: (d: { to: [number, number] }) => d.to,
          getColor: rgba(palette.accent),
          getWidth: 3,
          widthUnits: 'pixels',
        }),
      );
    }

    // A mark on every annotated image once cells are big enough to carry
    // one (CONTEXT.md "Making sense": the board shows where analysis is).
    if (annotatedRanks.length && zoom >= -2) {
      list.push(
        new PolygonLayer({
          id: 'annotated-marks',
          data: annotatedRanks,
          getPolygon: (rank: number) => cellCorner(rank, 20),
          stroked: false,
          filled: true,
          getFillColor: rgba(palette.claimOwn, 230),
        }),
      );
    }

    const outlineRanks = selectedImages
      .map((i) => i.rank)
      .filter((r): r is number => typeof r === 'number');
    if (outlineRanks.length) {
      list.push(
        new PolygonLayer({
          id: 'selection-outline',
          data: outlineRanks.map((rank) => cellPolygon(rank)),
          getPolygon: (d) => d,
          stroked: true,
          filled: false,
          getLineColor: accent,
          getLineWidth: 2,
          lineWidthUnits: 'pixels',
        }),
      );
    }

    if (flashId) {
      const flashImg = selectedImages.find((i) => i.id === flashId);
      if (flashImg && typeof flashImg.rank === 'number') {
        list.push(
          new PolygonLayer({
            id: 'tray-flash',
            data: [cellPolygon(flashImg.rank)],
            getPolygon: (d) => d,
            stroked: true,
            filled: false,
            getLineColor: rgba(palette.textPrimary),
            getLineWidth: 3,
            lineWidthUnits: 'pixels',
          }),
        );
      }
    }

    // Other viewers: their selections outlined in their colour, their hover
    // outlined thicker and named.
    if (outlines.length) {
      list.push(
        new PolygonLayer({
          id: 'presence-outlines',
          data: outlines,
          getPolygon: (d) => cellPolygon(d.rank),
          stroked: true,
          filled: false,
          getLineColor: (d) => d.colour,
          getLineWidth: (d) => (d.name ? 3 : 2),
          lineWidthUnits: 'pixels',
        }),
      );
      const named = outlines.filter((o) => o.name);
      if (named.length)
        list.push(
          new TextLayer({
            id: 'presence-names',
            data: named,
            // Just above the cell's top-left corner.
            getPosition: (d) => {
              const { col, row } = cellOf(d.rank);
              return [col * CELL, row * CELL];
            },
            getText: (d) => d.name ?? '',
            getColor: [255, 255, 255],
            getSize: 11,
            background: true,
            getBackgroundColor: (d) => d.colour,
            getTextAnchor: 'start',
            getAlignmentBaseline: 'bottom',
            fontFamily: 'system-ui, sans-serif',
          }),
        );
    }

    deckRef.current.setProps({ layers: list });
    forceRender((n) => n + 1);
  }, [
    board,
    currentSortId,
    tileVersion,
    fetchTile,
    sections,
    selectedImages,
    flashId,
    findResult,
    finder.dimmed,
    outlines,
    zoom,
    palette,
    annotatedRanks,
    exploreGraph,
    exploreRanks,
    detailKey,
    detailCells,
    detailBitmaps,
    focusedImageId,
    pathImages,
  ]);

  // -- hover: hold still 150ms, then look up the rank under the pointer -----
  function handleHover(info: PickingInfo) {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    const b = boardRef.current;
    if (!b || !info.coordinate) {
      setHoverTooltip(null);
      return;
    }
    const [wx, wy] = info.coordinate as [number, number];
    const rank = rankAtWorld(wx, wy);
    if (rank < 0 || rank >= b.imageCount) {
      setHoverTooltip(null);
      return;
    }
    const screenX = info.x;
    const screenY = info.y;
    hoverTimerRef.current = window.setTimeout(() => {
      void resolveHover(rank, screenX, screenY);
    }, 150);
  }

  async function resolveHover(rank: number, x: number, y: number) {
    const image = await resolveImageAtRank(rank);
    setHoverTooltip(image ? { x, y, rank, image } : null);
  }

  // -- click: plain replaces (toggles off if it's already the sole
  // selection), Ctrl/Cmd toggles without clearing, Shift extends a range
  // from the last-clicked rank under the current sort (design.md §5.1). ----
  function handleClick(
    info: PickingInfo,
    event: {
      srcEvent?: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean };
    },
  ) {
    const b = boardRef.current;
    if (!b || !info.coordinate) return;
    const [wx, wy] = info.coordinate as [number, number];
    const rank = rankAtWorld(wx, wy);
    if (rank < 0 || rank >= b.imageCount) return;
    const native = event?.srcEvent;
    void press({
      rank,
      toggle: !!(native?.ctrlKey || native?.metaKey),
      extend: !!native?.shiftKey,
    });
  }

  /** board/selection.ts#pressMove decides; this does it. */
  async function press(p: Press) {
    const move = await pressMove(
      p,
      lastClickRankRef.current,
      selection.imageIds,
      async (rank) => (await resolveImageAtRank(rank))?.id ?? null,
    );
    lastClickRankRef.current = move.anchor;
    if (move.kind === 'range') await rangeSelect(move.from, move.to);
    else if (move.kind === 'toggle') selection.toggle(move.id);
    else if (move.kind === 'only') selection.replace([move.id]);
    else if (move.kind === 'clear') selection.clear();
  }

  function clearSelection() {
    selection.clear();
    setSelectionNote('');
  }

  function selectAllMatches() {
    if (!findResult?.imageIds.length) return;
    selection.replace(findResult.imageIds);
    setSelectionNote(
      findResult.count > findResult.imageIds.length
        ? `Selected the first ${findResult.imageIds.length} of ${findResult.count} matches`
        : '',
    );
  }

  async function invertSelection() {
    const b = boardRef.current;
    if (!b) return;
    try {
      const { images: all } = await api.listBoardImages(
        boardId,
        currentSortId,
        0,
        b.imageCount,
      );
      const have = new Set(selection.imageIds);
      selection.replace(all.filter((i) => !have.has(i.id)).map((i) => i.id));
    } catch {
      // nothing to invert against
    }
  }

  async function selectSheetImages(sheetId: string) {
    try {
      const sheet = await api.getSheet(sheetId);
      selection.replace(sheet.images.map((i) => i.id));
    } catch {
      // sheet unreachable; leave the selection untouched
    }
  }

  // -- zoom control ----------------------------------------------------------
  function applyZoom(next: number) {
    moveView((cam) => zoomTo(cam, next));
  }
  function fitView() {
    if (!board) return;
    setView(fitBoard(board.imageCount, screenSize(), true));
  }
  function zoomToSelection() {
    const ranks = selectedImages
      .map((i) => i.rank)
      .filter((r): r is number => typeof r === 'number');
    moveView((cam) => fitRanks(cam, ranks, screenSize()));
  }
  /** Walks the graph: the neighbour joins the selection, becomes the focused
   * image, and the map centres on it. */
  function visitImage(imgId: string) {
    selection.add([imgId]);
    setFocusedImageId(imgId);
    const rank = exploreRanks.get(imgId);
    if (rank !== undefined) moveView((cam) => centreOn(cam, rank));
  }

  /** Centres the map on a picture and opens its details, leaving the
   * selection alone: looking is not choosing. */
  function showOnMap(imageId: string, rank: number) {
    if (rank < 0) return;
    moveView((cam) => centreOn(cam, rank));
    setFocusedImageId(imageId);
  }

  function flyToImage(imgId: string) {
    const img = selectedImages.find((i) => i.id === imgId);
    // An image uploaded after the last rank build has no cell yet: open it,
    // and say so, rather than ignore the click.
    if (img && typeof img.rank !== 'number') {
      setFocusedImageId(imgId);
      setSelectionNote(
        'This image is not on the map yet. It appears after the next arrangement.',
      );
      return;
    }
    if (!img || typeof img.rank !== 'number') return;
    const rank = img.rank;
    moveView((cam) => centreOn(cam, rank));
    setFocusedImageId(imgId);
  }

  // -- right-click / Actions menu (design.md §5.2) --------------------------
  function worldCoordAt(x: number, y: number): [number, number] | null {
    const vp = deckRef.current?.getViewports()?.[0];
    if (!vp) return null;
    return vp.unproject([x, y]) as [number, number];
  }

  function buildEmptyCanvasMenu(): MenuSection[] {
    const fitGroup: MenuItem[] = [
      { label: 'Fit everything', onSelect: fitView },
    ];
    if (selection.imageIds.length) {
      fitGroup.push({
        label: 'Zoom to the selection',
        onSelect: zoomToSelection,
      });
    }
    const matchGroup: MenuItem[] = [
      {
        label: findResult
          ? `Select all matches (${Math.min(findResult.count, findResult.imageIds.length)})`
          : 'Find and filter…',
        onSelect: findResult ? selectAllMatches : () => setFindOpen(true),
        disabled: findResult !== null && findResult.imageIds.length === 0,
      },
    ];
    if (selection.imageIds.length) {
      matchGroup.push({ label: 'Clear selection', onSelect: clearSelection });
      matchGroup.push(...copyItems(selection.imageIds));
    }
    const uploadGroup: MenuItem[] = [
      { label: 'Upload images', onSelect: () => fileInputRef.current?.click() },
      {
        label: 'Import a folder from the server…',
        testId: 'board-menu-folder-import',
        onSelect: () => setFolderImport(true),
      },
    ];
    const undoGroup: MenuItem[] = [
      {
        label: 'Undo selection',
        onSelect: () => selection.undo(),
        disabled: !selection.canUndo,
      },
      {
        label: 'Redo selection',
        onSelect: () => selection.redo(),
        disabled: !selection.canRedo,
      },
    ];
    return [fitGroup, matchGroup, uploadGroup, undoGroup];
  }

  function buildImageMenu(img: BoardImage, rank: number): MenuSection[] {
    const inSelection = selection.imageIds.includes(img.id);
    const actingIds =
      inSelection && selection.imageIds.length > 1
        ? selection.imageIds
        : [img.id];
    const section = sectionsRef.current.find(
      (s) => rank >= s.fromRank && rank <= s.toRank,
    );
    const exploreGroup: MenuItem[] = [
      {
        label: 'Explore connections',
        onSelect: () => setFocusedImageId(img.id),
      },
      {
        label: 'Select neighbourhood…',
        onSelect: () => setFocusedImageId(img.id),
      },
    ];
    if (section) {
      exploreGroup.push({
        label: `Select this section ("${section.label}")`,
        onSelect: () => sectionSelect(section),
      });
    }
    const sheetGroup: MenuItem[] = [
      {
        label: 'Start a sheet',
        onSelect: () => {
          selection.replace(actingIds);
          setStartSheetRequested(true);
        },
      },
      {
        label: 'Add to sheet…',
        onSelect: () => {
          selection.replace(actingIds);
          setAddSheetRequested(true);
        },
      },
    ];
    const openGroup: MenuItem[] = [
      {
        label: 'Open image',
        onSelect: () => window.open(api.originalUrl(img.id), '_blank'),
      },
    ];
    const propsGroup: MenuItem[] = [
      { label: 'Properties', onSelect: () => selection.replace([img.id]) },
    ];
    // A picture that is part of the selection stands for all of it.
    const copyGroup = copyItems(
      selection.imageIds.includes(img.id) ? selection.imageIds : [img.id],
    );
    return [exploreGroup, sheetGroup, openGroup, propsGroup, copyGroup];
  }

  // -- copy to another board, and download (POST …/images/copy, GET
  // …/images/download) ---------------------------------------------------
  function copyItems(ids: readonly string[]): MenuItem[] {
    const many = ids.length > 1 ? ` ${ids.length} pictures` : '';
    return [
      {
        label: `Copy${many} to another board…`,
        testId: 'board-menu-copy',
        onSelect: () => setCopying([...ids]),
      },
      {
        label: `Download${many}`,
        testId: 'board-menu-download',
        onSelect: () => download(ids),
        disabled: ids.length > DOWNLOAD_MAX,
        disabledReason: `At most ${DOWNLOAD_MAX} pictures in one download.`,
      },
    ];
  }
  /** A plain link, so the browser keeps its own download: the ids while
   * they fit a URL, else the stored selection they came from. */
  function download(ids: readonly string[]) {
    const a = document.createElement('a');
    a.href = api.downloadUrl(
      boardId,
      ids.length <= DOWNLOAD_BY_IDS ? ids : 'selection',
    );
    a.download = '';
    a.click();
  }

  function openActionsMenu(x: number, y: number) {
    setContextMenu({ x, y, sections: buildEmptyCanvasMenu() });
  }

  function clearLongPress() {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }

  async function openContextMenu(
    clientX: number,
    clientY: number,
    coord: [number, number] | null,
  ) {
    const b = boardRef.current;
    let rank = -1;
    if (b && coord) {
      const r = rankAtWorld(coord[0], coord[1]);
      if (r >= 0 && r < b.imageCount) rank = r;
    }
    const img = rank >= 0 ? await resolveImageAtRank(rank) : null;
    const sections2 = img ? buildImageMenu(img, rank) : buildEmptyCanvasMenu();
    setContextMenu({ x: clientX, y: clientY, sections: sections2 });
  }

  // -- detail ------------------------------------------------------------------
  useEffect(() => {
    if (!focusedImageId) {
      setDetailImage(null);
      return;
    }
    let cancelled = false;
    void api.getImage(focusedImageId).then((img) => {
      if (cancelled) return;
      setDetailImage(img);
      setDetailSaveState('idle');
    });
    return () => {
      cancelled = true;
    };
  }, [focusedImageId]);

  async function saveDetailProperties(next: Properties) {
    if (!detailImage) return;
    setDetailImage({ ...detailImage, properties: next });
    setDetailSaveState('saving');
    try {
      const res = await api.updateImageProperties(detailImage.id, {
        properties: next,
      });
      setDetailImage((prev) =>
        prev ? { ...prev, properties: res.properties } : prev,
      );
      setDetailSaveState('saved');
    } catch {
      setDetailSaveState('error');
    }
  }

  function setDetailProperty(key: string, value: PropertyValue) {
    if (!detailImage) return;
    void saveDetailProperties({ ...detailImage.properties, [key]: value });
  }

  function removeDetailProperty(key: string) {
    if (!detailImage) return;
    const next = { ...detailImage.properties };
    delete next[key];
    void saveDetailProperties(next);
  }

  // -- image delete (docs/phases/3-groups.md section 4): the row, slot and
  // every claim stay; only `missing` flips. The map answers with a tile
  // refetch (bump `tileVersion`, same as after an upload); every cached
  // copy of this image (hover, resolveImageAtRank) is patched in place so
  // the dimmed "missing" state shows without a full reload. ------------------
  async function deleteDetailImage() {
    if (!detailImage) return;
    const imageId = detailImage.id;
    try {
      await api.deleteImage(imageId);
    } catch {
      setDetailSaveState('error');
      return;
    }
    setFocusedImageId(null);
    setDetailImage(null);
    setTileVersion((n) => n + 1);
    for (const cache of imageCacheRef.current.values()) {
      for (const [rank, cached] of cache) {
        if (cached?.id === imageId)
          cache.set(rank, { ...cached, missing: true });
      }
    }
    setMarkedMissing((prev) => new Set(prev).add(imageId));
  }

  // -- upload ------------------------------------------------------------------
  function handleFiles(files: FileList | File[] | null) {
    if (!files || !files.length || !board) return;
    enqueueUploads(boardId, Array.from(files));
  }

  // -- tray actions: start a sheet (layout follows TRAY order — the order
  // of `selectedImages`, i.e. selection order), add to an existing sheet ---
  async function startSheetFromTray(name: string) {
    const ids = selectedImages.slice(0, SHEET_LIMIT).map((i) => i.id);
    if (!name.trim() || !ids.length) return;
    const { id: newId } = await api.createSheet(boardId, {
      name: name.trim(),
      imageIds: ids,
    });
    notifySheetsChanged();
    navigate(`/s/${newId}`);
  }
  async function addSelectionToSheet(sheetId: string) {
    const ids = selectedImages.map((i) => i.id);
    if (!ids.length) return;
    await api.addSheetImages(boardId, sheetId, { imageIds: ids });
    notifySheetsChanged();
  }

  // -- the right column: what you are looking at first (the focused image,
  // then where it leads), then the board's sheets, then the board itself.
  // DOM order is reading order; nothing is reordered in CSS.
  useRightColumn(
    board && (
      <div className="board-right" data-testid="board-side">
        {pathEnds && (
          <PathPanel
            boardId={boardId}
            sort={currentSortId}
            a={pathEnds[0]}
            b={pathEnds[1]}
            onPath={setPathImages}
            onShowImage={showOnMap}
            onOpenWeb={() => setWebRoots([pathEnds[0].id, pathEnds[1].id])}
            onClose={() => setPathEnds(null)}
          />
        )}
        {detailImage && (
          <Detail
            image={detailImage}
            originalUrl={api.originalUrl(detailImage.id)}
            saveState={detailSaveState}
            onSetProperty={setDetailProperty}
            onRemoveProperty={removeDetailProperty}
            onDelete={() => void deleteDetailImage()}
            onClose={() => setFocusedImageId(null)}
            onMoreLike={() => {
              finder.dispatch({
                type: 'like',
                image: { id: detailImage.id, name: detailImage.name },
              });
              setFindOpen(true);
            }}
          />
        )}
        {detailImage && !detailImage.missing && (
          <Copies
            boardId={boardId}
            sort={currentSortId}
            imageId={detailImage.id}
            onShow={showOnMap}
            onSelect={(ids) => selection.replace(ids)}
            onCompare={async (copyId) => {
              const copy = await api.getImage(copyId).catch(() => null);
              setComparing([
                {
                  src: api.originalUrl(detailImage.id),
                  name: detailImage.name,
                  focus: WHOLE,
                },
                {
                  src: api.originalUrl(copyId),
                  name: copy?.name ?? 'The copy',
                  focus: WHOLE,
                },
              ]);
            }}
          />
        )}
        {detailImage && !detailImage.missing && (
          <Explore
            boardId={boardId}
            imageId={detailImage.id}
            onOpenWeb={() => setWebRoots([detailImage.id])}
            currentSelectionCount={selectedImages.length}
            onSelectImages={(ids, mode) => {
              if (mode === 'add') selection.add(ids);
              else selection.replace(ids ?? []);
            }}
            onGraph={setExploreGraph}
            onVisit={visitImage}
          />
        )}

        <Terms
          vocab={vocab}
          active={finder.question.claim}
          onPick={(claim) => {
            finder.dispatch({ type: 'claim', claim });
            if (claim) setFindOpen(true);
          }}
          onOpenWeb={(relation) => {
            // The whole web of the relation, across every sheet (WebView
            // asks relation-web when it has no starting picture).
            setWebRelation(relation);
            setWebRoots([]);
          }}
        />

        <BoardSheets
          boardId={boardId}
          groupId={board.groupId}
          sheets={sheets}
          onSelect={(sheetId) => void selectSheetImages(sheetId)}
        />
        <BoardAdministration board={board} />
      </div>
    ),
  );

  if (boardError) return <ErrorState info={boardError} />;
  if (!board) return <div className="page">loading…</div>;

  const s = statusRef.current;
  const cacheRatio =
    s.cacheTotal === 0
      ? '-'
      : `${((s.cacheHits / s.cacheTotal) * 100).toFixed(1)}%`;

  return (
    // Fills the shell's page outlet (shell/shell.css's `.shell-page`) —
    // the board's own side panel now lives in the shell's right column
    // (useRightColumn above), so this is canvas + floating chrome only.
    <div
      className="board-canvas-wrap"
      onDragEnter={(event) => {
        if (!Array.from(event.dataTransfer.types).includes('Files')) return;
        event.preventDefault();
        setFileDragActive(true);
      }}
      onDragOver={(event) => {
        if (!Array.from(event.dataTransfer.types).includes('Files')) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        setFileDragActive(true);
      }}
      onDragLeave={(event) => {
        const nextTarget = event.relatedTarget;
        if (!nextTarget || !event.currentTarget.contains(nextTarget as Node)) {
          setFileDragActive(false);
        }
      }}
      onDrop={(event) => {
        if (!Array.from(event.dataTransfer.types).includes('Files')) return;
        event.preventDefault();
        setFileDragActive(false);
        handleFiles(event.dataTransfer.files);
      }}
    >
      {fileDragActive && (
        <output className="board-file-drop-hint" aria-live="polite">
          Drop images to add them to this board
        </output>
      )}
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: '100%', display: 'block' }}
        onContextMenu={(e) => {
          e.preventDefault();
          const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
          const coord = worldCoordAt(
            e.clientX - rect.left,
            e.clientY - rect.top,
          );
          void openContextMenu(e.clientX, e.clientY, coord);
        }}
        onTouchStart={(e) => {
          clearLongPress();
          const touch = e.touches[0];
          if (!touch) return;
          const { clientX, clientY } = touch;
          const canvas = e.currentTarget;
          longPressTimerRef.current = window.setTimeout(() => {
            const rect = canvas.getBoundingClientRect();
            const coord = worldCoordAt(clientX - rect.left, clientY - rect.top);
            void openContextMenu(clientX, clientY, coord);
            longPressTimerRef.current = null;
          }, 550);
        }}
        onTouchMove={clearLongPress}
        onTouchEnd={clearLongPress}
        onTouchCancel={clearLongPress}
      />
      <div
        className="status-line board-debug-status"
        data-testid="status"
        aria-hidden="true"
      >
        zoom={s.zoom.toFixed(2)} tiles={s.tilesRequested} cache={cacheRatio}{' '}
        ttft=
        {s.ttftMs === null ? '-' : `${s.ttftMs.toFixed(0)}ms`}
        {sectionsTruncated ? ' · sections truncated at 500' : ''}
      </div>
      <header className="board-toolbar">
        <div className="board-toolbar-copy">
          <div className="board-toolbar-title-row">
            <h1>
              <RenameInline
                name={board.name}
                onRename={renameBoard}
                testId="board-rename"
                style={{ fontSize: 17, fontWeight: 680 }}
              />
            </h1>
            <span className="board-count-badge">
              {plural(board.imageCount, 'image')}
            </span>
            {othersHere.length > 0 && (
              <span
                className="board-presence"
                data-testid="board-presence"
                title={`Also here: ${othersHere.map((p) => p.name).join(', ')}`}
              >
                {othersHere.map((p) => (
                  <span key={p.name} className="board-presence-person">
                    <span
                      className="board-presence-dot"
                      style={{ background: p.colour }}
                      aria-hidden="true"
                    />
                    {p.name}
                  </span>
                ))}
              </span>
            )}
          </div>
        </div>
        <div className="board-toolbar-controls">
          <button
            type="button"
            className="board-tool-button board-tool-icon"
            aria-label="Board actions"
            title="Board actions"
            data-testid="board-actions-button"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              openActionsMenu(rect.left, rect.bottom + 4);
            }}
          >
            <Icon name="more" />
          </button>
          <button
            type="button"
            className={`board-tool-button board-tool-icon${findOpen ? ' is-active' : ''}`}
            aria-label={findOpen ? 'Close find and filter' : 'Find and filter'}
            data-testid="board-find-toggle"
            onClick={() => setFindOpen((open) => !open)}
          >
            <Icon name="search" />
          </button>
          <div className="board-sort-control">
            <span className="board-sort-label">Arrange by</span>
            <select
              aria-label="Arrange images by"
              data-testid="sort-key"
              value={JSON.stringify(sort.key)}
              onChange={(e) =>
                changeSort({
                  ...sort,
                  key: JSON.parse(e.target.value) as SortKey,
                })
              }
            >
              {board.sortableKeys.map((k) => (
                <option
                  key={JSON.stringify(k.key)}
                  value={JSON.stringify(k.key)}
                >
                  {k.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="board-sort-direction"
              aria-label={`Sort ${sort.dir === 'asc' ? 'descending' : 'ascending'}`}
              title={sort.dir === 'asc' ? 'Ascending' : 'Descending'}
              data-testid="sort-dir"
              onClick={() =>
                changeSort({
                  ...sort,
                  dir: sort.dir === 'asc' ? 'desc' : 'asc',
                })
              }
            >
              <Icon name={sort.dir === 'asc' ? 'arrowUp' : 'arrowDown'} />
            </button>
          </div>
          <button
            type="button"
            className="board-upload-button"
            data-testid="board-upload-button"
            aria-label="Add images"
            onClick={() => fileInputRef.current?.click()}
          >
            <Icon name="upload" />
            <span className="board-upload-label">
              {uploading ? (
                <>
                  Add more{' '}
                  <span className="board-upload-image-word">images</span>
                </>
              ) : (
                <>
                  Add <span className="board-upload-image-word">images</span>
                </>
              )}
            </span>
          </button>
          <label className="board-file-input-label">
            <input
              ref={fileInputRef}
              data-testid="upload-input"
              type="file"
              multiple
              aria-label="Choose images to add to this board"
              tabIndex={-1}
              onChange={(e) => {
                const input = e.currentTarget;
                handleFiles(input.files);
                input.value = '';
              }}
            />
          </label>
        </div>
      </header>
      {findOpen && (
        <FindPanel
          question={finder.question}
          dispatch={finder.dispatch}
          result={findResult}
          error={finder.error}
          sortableKeys={board.sortableKeys}
          onSelectAll={selectAllMatches}
          onShowOnMap={showOnMap}
        />
      )}
      {hoverTooltip && (
        <div
          className="board-hover-card"
          data-testid="hover-tooltip"
          data-rank={hoverTooltip.rank}
          style={{ left: hoverTooltip.x + 14, top: hoverTooltip.y + 14 }}
        >
          <b>{hoverTooltip.image.name}</b>
          {Object.entries(hoverTooltip.image.properties).length > 0 && (
            <dl>
              {Object.entries(hoverTooltip.image.properties).map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{String(v)}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}
      <UploadActivity boardId={boardId} snapshot={uploadSnapshot} />
      {copying && (
        <CopyToBoard
          boardId={boardId}
          groupId={board.groupId}
          imageIds={copying}
          onClose={() => setCopying(null)}
        />
      )}
      {folderImport && (
        <FolderImport
          boardId={boardId}
          onClose={() => setFolderImport(false)}
          onProgress={() => {
            setTileVersion((value) => value + 1);
            void api
              .getBoard(boardId)
              .then(setBoard)
              .catch(() => {});
          }}
        />
      )}

      <ZoomControl
        zoom={s.zoom}
        minZoom={MIN_ZOOM}
        maxZoom={MAX_ZOOM}
        onZoomIn={() => applyZoom(zoomIn(s.zoom, MAX_ZOOM))}
        onZoomOut={() => applyZoom(zoomOut(s.zoom, MIN_ZOOM))}
        onReset={() => applyZoom(0)}
        onFit={fitView}
      />

      <Tray
        items={selectedImages}
        sheets={sheets}
        onRemove={(id) => selection.remove([id])}
        onReorder={(ids) => selection.reorder(ids)}
        onHoverItem={(id) => setFlashId(id)}
        onClickItem={flyToImage}
        onClear={clearSelection}
        onInvert={() => void invertSelection()}
        onStartSheet={startSheetFromTray}
        onAddToSheet={addSelectionToSheet}
        onFindPath={() => {
          const [first, second] = selectedImages;
          if (first && second)
            setPathEnds([
              { id: first.id, name: first.name },
              { id: second.id, name: second.name },
            ]);
        }}
        onCompare={() => {
          const [first, second] = selectedImages;
          if (!first || !second) return;
          const end = (img: BoardImage): CompareEnd => ({
            src: api.originalUrl(img.id),
            name: img.name,
            focus: WHOLE,
          });
          setComparing([end(first), end(second)]);
        }}
        startRequested={startSheetRequested}
        onStartRequested={() => setStartSheetRequested(false)}
        addRequested={addSheetRequested}
        onAddRequested={() => setAddSheetRequested(false)}
      />

      {selectionNote && <output className="board-note">{selectionNote}</output>}
      {webRoots && (
        <WebView
          boardId={boardId}
          sort={currentSortId}
          roots={webRoots}
          relation={webRelation}
          onShowOnBoard={showOnMap}
          onClose={() => {
            setWebRoots(null);
            setWebRelation(undefined);
          }}
        />
      )}
      {comparing && (
        <Compare
          a={comparing[0]}
          b={comparing[1]}
          onClose={() => setComparing(null)}
        />
      )}

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          sections={contextMenu.sections}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}
