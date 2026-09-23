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
  type OrthographicViewState,
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
import {
  ContextMenu,
  type MenuItem,
  type MenuSection,
} from '../board/ContextMenu.tsx';
import { Copies } from '../board/Copies.tsx';
import { Detail } from '../board/Detail.tsx';
import { Explore } from '../board/Explore.tsx';
import { FindPanel } from '../board/FindPanel.tsx';
import { FolderImport } from '../board/FolderImport.tsx';
import { PathPanel } from '../board/PathPanel.tsx';
import { Terms } from '../board/Terms.tsx';
import { ThreadBrowser } from '../board/ThreadBrowser.tsx';
import { Tray } from '../board/Tray.tsx';
import { UploadActivity } from '../board/UploadActivity.tsx';
import { WebView } from '../board/WebView.tsx';
import { ZoomControl, zoomIn, zoomOut } from '../board/ZoomControl.tsx';
import {
  DetailCache,
  MAX_VIEW_ZOOM,
  containedRect,
  visibleRanks,
} from '../board/detail.ts';
import { useFind } from '../board/find.ts';
import { boardDeleteMessage, sheetDeleteMessage } from '../board/messages.ts';
import { RankedView, identity, useRanked } from '../board/ranked-view.ts';
import { sectionMarkers, sectionsVisible } from '../board/sections-layer.ts';
import { cellCorner, cellPolygon } from '../board/selection.ts';
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
import { Confirm } from '../components/Confirm.tsx';
import {
  ErrorState,
  type ErrorStateInfo,
  fromCaught,
} from '../components/ErrorState.tsx';
import { Icon } from '../components/Icon.tsx';
import { RenameInline } from '../components/RenameInline.tsx';
import {
  ApiError,
  type BoardFootprint,
  type GetBoardAllowlistResponse,
  type GetBoardResponseWithGroup,
  type SheetFootprint,
  api,
} from '../lib/api.ts';
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

const MIN_ZOOM = -5;
/** The tile pyramid's finest level: a cell is 128 px, as a ladder page
 * stores it. The view zooms past it (MAX_ZOOM) and board/detail.ts draws
 * each visible cell's own preview there. */
const MAX_TILE_ZOOM = 0;
const MAX_ZOOM = MAX_VIEW_ZOOM;
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

/** Today a sheet's save reads as a time; before today, as a date. */
function savedLabel(iso: string): string {
  const at = new Date(iso);
  const today = new Date().toDateString() === at.toDateString();
  return today
    ? `Saved ${at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
    : `Saved ${at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

function storageKey(boardId: string): string {
  return `digsite:sort:${boardId}`;
}

/**
 * `worldExtent(count)` is the shared tiling boundary the TileLayer needs.
 * Fit the used ranks rather than the full fixed row width so a smaller
 * collection opens centered on its images; the shared column count keeps
 * ranks in a stable compact grid as new images arrive.
 *
 * docs/ux/audit.md #15: the mathematically tightest fit (width-driven, for
 * any board whose one row is wider than the viewport) can render a single
 * row as a near-invisible sliver — a `zoomX` that fits a wide row into the
 * viewport width shrinks that row's on-screen HEIGHT by the exact same
 * factor. Floor zoom at a fixed minimum on-screen cell size instead of
 * deriving it from the viewport height: a floor derived from `h` (e.g.
 * "zoom until 2 real cell-rows fill the viewport") degenerates to
 * `MAX_ZOOM` for any board whose row COUNT is small — that was tried and
 * measured to force full zoom-in (cellPx=128), hiding most of a merely
 * medium-sized board's width behind an artificially tight crop. A fixed
 * pixel floor has no such degenerate case: it only ever pulls zoom UP from
 * a genuinely-too-coarse fit, by exactly enough to keep a cell legible.
 */
const MIN_INITIAL_CELL_PX = 64; // half native size — comfortably legible, never a sliver
function fitInitialViewState(
  count: number,
  worldH: number,
  viewportW: number,
  viewportH: number,
  fitEverything = false,
): OrthographicViewState {
  const contentW = Math.min(Math.max(count, 1), COLS) * CELL;
  const zoomX = Math.log2(viewportW / contentW);
  const zoomY = Math.log2(viewportH / worldH);
  let zoom = Math.min(zoomX, zoomY);
  // Keep cells legible where possible, but never let the preferred cell
  // floor force a compact 16-column board wider than its actual canvas.
  const zoomFloor = Math.min(Math.log2(MIN_INITIAL_CELL_PX / CELL), zoomX);
  if (!fitEverything) zoom = Math.max(zoom, zoomFloor);
  // A fit shows the map, so it stops where the tiles do.
  zoom = Math.max(MIN_ZOOM, Math.min(MAX_TILE_ZOOM, zoom));
  return {
    target: [contentW / 2, worldH / 2, 0],
    zoom,
    minZoom: MIN_ZOOM,
    maxZoom: MAX_ZOOM,
  };
}

/** The web of one relation starts from at most this many pictures: one
 * neighbourhood request each. */
const WEB_STARTS = 40;

const NO_SECTIONS: Section[] = [];
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
  const viewStateRef = useRef<OrthographicViewState | null>(null);
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
  const boardRef = useRef<GetBoardResponseWithGroup | null>(null);

  const [board, setBoard] = useState<GetBoardResponseWithGroup | null>(null);
  boardRef.current = board;
  const [boardError, setBoardError] = useState<ErrorStateInfo | null>(null);
  const [sort, setSort] = useState<Sort>(DEFAULT_SORT);
  const [tileVersion, setTileVersion] = useState(0);
  const [folderImport, setFolderImport] = useState(false);
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

  // -- sheets (docs/phases/2-sheet.md section 6) ------------------------------
  const [sheets, setSheets] = useState<
    Awaited<ReturnType<typeof api.listSheets>>
  >([]);
  const refreshSheets = useCallback(async () => {
    setSheets(await api.listSheets(boardId));
  }, [boardId]);
  useEffect(() => {
    void refreshSheets();
  }, [refreshSheets]);

  // -- sheet delete, with a footprint confirmation (docs/phases/3-groups.md
  // section 4: "how many other sheets' foreign views it affects") ----------
  const [sheetDeleteConfirm, setSheetDeleteConfirm] = useState<{
    sheetId: string;
    footprint: SheetFootprint;
  } | null>(null);
  const [sheetDeleteBusy, setSheetDeleteBusy] = useState(false);
  const [sheetDeleteError, setSheetDeleteError] = useState<string | null>(null);

  async function openSheetDeleteConfirm(sheetId: string) {
    setSheetDeleteError(null);
    try {
      const footprint = await api.getSheetFootprint(sheetId);
      setSheetDeleteConfirm({ sheetId, footprint });
    } catch (err) {
      setSheetDeleteError(err instanceof ApiError ? err.reason : String(err));
    }
  }
  async function confirmDeleteSheet() {
    if (!sheetDeleteConfirm) return;
    setSheetDeleteBusy(true);
    try {
      await api.deleteSheet(sheetDeleteConfirm.sheetId);
      setSheetDeleteConfirm(null);
      await refreshSheets();
      notifySheetsChanged();
    } catch (err) {
      setSheetDeleteError(err instanceof ApiError ? err.reason : String(err));
    } finally {
      setSheetDeleteBusy(false);
    }
  }

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

  // -- allowlist (docs/phases/3-groups.md section 3): only meaningful on a
  // private board, so only fetched once the board says it isn't open -------
  const [allowlist, setAllowlist] = useState<GetBoardAllowlistResponse | null>(
    null,
  );
  const [groupMembers, setGroupMembers] = useState<
    Awaited<ReturnType<typeof api.listMembers>>
  >([]);
  const [allowlistPick, setAllowlistPick] = useState('');
  const [allowlistError, setAllowlistError] = useState<string | null>(null);

  const refreshAllowlist = useCallback(async () => {
    if (!board || board.open) return;
    try {
      const [al, gm] = await Promise.all([
        api.getBoardAllowlist(boardId),
        api.listMembers(board.groupId),
      ]);
      setAllowlist(al);
      setGroupMembers(gm);
      setAllowlistError(null);
    } catch (err) {
      setAllowlistError(err instanceof ApiError ? err.reason : String(err));
    }
  }, [board, boardId]);
  useEffect(() => {
    void refreshAllowlist();
  }, [refreshAllowlist]);

  async function addToAllowlist(userId: string) {
    setAllowlistError(null);
    try {
      await api.addToAllowlist(boardId, { userId });
      await refreshAllowlist();
    } catch (err) {
      setAllowlistError(err instanceof ApiError ? err.reason : String(err));
    }
  }
  async function removeFromAllowlist(userId: string) {
    setAllowlistError(null);
    try {
      await api.removeFromAllowlist(boardId, userId);
      await refreshAllowlist();
    } catch (err) {
      setAllowlistError(err instanceof ApiError ? err.reason : String(err));
    }
  }

  // -- board rename and delete (docs/phases/3-groups.md section 4) ---------
  const [boardDeleteConfirm, setBoardDeleteConfirm] =
    useState<BoardFootprint | null>(null);
  const [boardDeleteBusy, setBoardDeleteBusy] = useState(false);
  const [boardDeleteError, setBoardDeleteError] = useState<string | null>(null);

  async function renameBoard(name: string) {
    try {
      const res = await api.renameBoard(boardId, { name });
      setBoard((prev) => (prev ? { ...prev, name: res.name } : prev));
    } catch (err) {
      setBoardDeleteError(err instanceof ApiError ? err.reason : String(err));
    }
  }
  async function openBoardDeleteConfirm() {
    setBoardDeleteError(null);
    try {
      setBoardDeleteConfirm(await api.getBoardFootprint(boardId));
    } catch (err) {
      setBoardDeleteError(err instanceof ApiError ? err.reason : String(err));
    }
  }
  async function confirmDeleteBoard() {
    setBoardDeleteBusy(true);
    try {
      await api.deleteBoard(boardId);
      navigate(board ? `/g/${board.groupId}` : '/groups');
    } catch (err) {
      setBoardDeleteError(err instanceof ApiError ? err.reason : String(err));
      setBoardDeleteBusy(false);
    }
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
    const [, , , h] = worldExtent(board.imageCount);
    const canvasRect = canvasRef.current.getBoundingClientRect();
    viewStateRef.current = fitInitialViewState(
      board.imageCount,
      h,
      canvasRect.width || window.innerWidth,
      canvasRect.height || window.innerHeight - 200,
    );
    // deck.gl's onViewStateChange (below) only fires on a user-driven
    // change, never for the `initialViewState` passed at construction —
    // without this, `statusRef.current.zoom` stays at its literal `0`
    // default until the first pan/zoom, so ZoomControl's "zoom in"
    // disabled-when-at-max check (`zoom >= maxZoom`, maxZoom=0) reads
    // TRUE from the moment the page loads whenever the real initial fit
    // is negative (the common case) — the button was stuck disabled.
    statusRef.current.zoom = viewStateRef.current.zoom as number;
    forceRender((n) => n + 1);
    deckRef.current = new Deck({
      canvas: canvasRef.current,
      views: new OrthographicView({ id: 'board' }),
      initialViewState: viewStateRef.current,
      controller: true,
      layers: [],
      onViewStateChange: ({ viewState }) => {
        viewStateRef.current = viewState as OrthographicViewState;
        statusRef.current.zoom = (viewState as OrthographicViewState)
          .zoom as number;
        forceRender((n) => n + 1);
      },
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
        const { col, row } = cellOf(firstImg.rank);
        const next: OrthographicViewState = {
          ...(viewStateRef.current ?? {}),
          target: [col * CELL + CELL / 2, row * CELL + CELL / 2, 0],
        };
        viewStateRef.current = next;
        deckRef.current.setProps({ viewState: next });
        forceRender((n) => n + 1);
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
      setZoom: (z: number) => {
        if (!deckRef.current || !viewStateRef.current) return;
        viewStateRef.current = { ...viewStateRef.current, zoom: z };
        deckRef.current.setProps({ viewState: viewStateRef.current });
        statusRef.current.zoom = z;
        forceRender((n) => n + 1);
      },
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
      goToRank: (rank: number) => {
        const { col, row } = cellOf(rank);
        const next = {
          ...(viewStateRef.current ?? fitInitialViewState(1, CELL, 640, 480)),
          target: [col * CELL + CELL / 2, row * CELL + CELL / 2, 0] as [
            number,
            number,
            number,
          ],
        };
        viewStateRef.current = next;
        deckRef.current?.setProps({ viewState: next });
        statusRef.current.zoom = next.zoom as number;
        forceRender((n) => n + 1);
      },
      selectImages: (ids: string[], mode: 'replace' | 'add' = 'replace') => {
        if (mode === 'add') selection.add(ids);
        else selection.replace(ids);
      },
    };
  }, [resolveImageAtRank, rangeSelect, selection]);

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
  const finder = useFind(view, findOpen, vocab.vocabulary.aliases);
  const findResult = finder.result;

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
  const [detailVersion, setDetailVersion] = useState(0);
  const detailCacheRef = useRef<DetailCache | null>(null);
  if (!detailCacheRef.current)
    detailCacheRef.current = new DetailCache(
      async (imageId) => {
        const res = await fetch(api.previewUrl(imageId), {
          credentials: 'include',
        });
        if (!res.ok) throw new Error(`preview failed: ${res.status}`);
        return createImageBitmap(await res.blob());
      },
      () => setDetailVersion((n) => n + 1),
    );
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
  // Which image each visible cell holds: one request for the whole view.
  useEffect(() => {
    if (!detailKey) return;
    const cache = sortCache(imageCacheRef.current, currentSortId);
    const missing = detailKey
      .split(',')
      .map(Number)
      .filter((rank) => !cache.has(rank));
    if (!missing.length) return;
    const from = Math.min(...missing);
    const count = Math.max(...missing) - from + 1;
    let cancelled = false;
    api
      .listBoardImages(boardId, currentSortId, from, count)
      .then(({ images }) => {
        images.forEach((img, i) => cache.set(from + i, img));
        if (!cancelled) setDetailVersion((n) => n + 1);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [detailKey, boardId, currentSortId]);

  // -- one layers array: tiles + sections + the selection outline -----------
  const zoom = statusRef.current.zoom;
  // biome-ignore lint/correctness/useExhaustiveDependencies: detailVersion is the signal that a preview bitmap or a cell's image arrived in a ref-held cache
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
      const cache = sortCache(imageCacheRef.current, currentSortId);
      for (const rank of detailKey.split(',').map(Number)) {
        const img = cache.get(rank);
        if (!img || img.status !== 'ready' || img.missing) continue;
        const bitmap = detailCacheRef.current?.get(img.id);
        if (!bitmap) continue;
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

    if (findResult?.ranks.length) {
      list.push(
        new PolygonLayer({
          id: 'find-matches',
          data: findResult.ranks.map((rank, order) => ({
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
    zoom,
    palette,
    annotatedRanks,
    exploreGraph,
    exploreRanks,
    detailKey,
    detailVersion,
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
    const ctrl = !!(native?.ctrlKey || native?.metaKey);
    const shift = !!native?.shiftKey;
    void resolveClick(rank, ctrl, shift);
  }

  async function resolveClick(rank: number, ctrl: boolean, shift: boolean) {
    if (shift && lastClickRankRef.current !== null) {
      await rangeSelect(lastClickRankRef.current, rank);
      lastClickRankRef.current = rank;
      return;
    }
    const img = await resolveImageAtRank(rank);
    if (!img) return;
    lastClickRankRef.current = rank;
    if (ctrl) {
      selection.toggle(img.id);
      return;
    }
    const cur = selection.imageIds;
    if (cur.length === 1 && cur[0] === img.id) {
      selection.clear();
    } else {
      selection.replace([img.id]);
    }
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
    if (!deckRef.current || !viewStateRef.current) return;
    viewStateRef.current = { ...viewStateRef.current, zoom: next };
    deckRef.current.setProps({ viewState: viewStateRef.current });
    statusRef.current.zoom = next;
    forceRender((n) => n + 1);
  }
  function fitView() {
    if (!board) return;
    const [, , , h] = worldExtent(board.imageCount);
    const canvasRect = canvasRef.current?.getBoundingClientRect();
    const next = fitInitialViewState(
      board.imageCount,
      h,
      canvasRect?.width || window.innerWidth,
      canvasRect?.height || window.innerHeight - 200,
      true,
    );
    viewStateRef.current = next;
    deckRef.current?.setProps({ viewState: next });
    statusRef.current.zoom = next.zoom as number;
    forceRender((n) => n + 1);
  }
  function zoomToSelection() {
    if (!deckRef.current) return;
    const ranks = selectedImages
      .map((i) => i.rank)
      .filter((r): r is number => typeof r === 'number');
    if (!ranks.length) return;
    const cells = ranks.map((r) => cellOf(r));
    const minCol = Math.min(...cells.map((c) => c.col));
    const maxCol = Math.max(...cells.map((c) => c.col));
    const minRow = Math.min(...cells.map((c) => c.row));
    const maxRow = Math.max(...cells.map((c) => c.row));
    const x0 = minCol * CELL;
    const x1 = (maxCol + 1) * CELL;
    const y0 = minRow * CELL;
    const y1 = (maxRow + 1) * CELL;
    const w = Math.max(x1 - x0, CELL);
    const h = Math.max(y1 - y0, CELL);
    const canvasRect = canvasRef.current?.getBoundingClientRect();
    const vw = canvasRect?.width || window.innerWidth;
    const vh = canvasRect?.height || window.innerHeight - 200;
    const nz = Math.max(
      MIN_ZOOM,
      Math.min(
        MAX_ZOOM,
        Math.min(Math.log2(vw / (w + CELL)), Math.log2(vh / (h + CELL))),
      ),
    );
    const next: OrthographicViewState = {
      ...(viewStateRef.current ?? {}),
      target: [(x0 + x1) / 2, (y0 + y1) / 2, 0],
      zoom: nz,
    };
    viewStateRef.current = next;
    deckRef.current.setProps({ viewState: next });
    statusRef.current.zoom = nz;
    forceRender((n) => n + 1);
  }
  /** Walks the graph: the neighbour joins the selection, becomes the focused
   * image, and the map centres on it. */
  function visitImage(imgId: string) {
    selection.add([imgId]);
    setFocusedImageId(imgId);
    const rank = exploreRanks.get(imgId);
    if (rank === undefined || !deckRef.current) return;
    const { col, row } = cellOf(rank);
    const next: OrthographicViewState = {
      ...(viewStateRef.current ?? {}),
      target: [col * CELL + CELL / 2, row * CELL + CELL / 2, 0],
    };
    viewStateRef.current = next;
    deckRef.current.setProps({ viewState: next });
    forceRender((n) => n + 1);
  }

  /** Centres the map on a picture and opens its details, leaving the
   * selection alone: looking is not choosing. */
  function showOnMap(imageId: string, rank: number) {
    if (rank < 0 || !deckRef.current) return;
    const { col, row } = cellOf(rank);
    const next: OrthographicViewState = {
      ...(viewStateRef.current ?? {}),
      target: [col * CELL + CELL / 2, row * CELL + CELL / 2, 0],
    };
    viewStateRef.current = next;
    deckRef.current.setProps({ viewState: next });
    forceRender((n) => n + 1);
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
    if (!img || typeof img.rank !== 'number' || !deckRef.current) return;
    const { col, row } = cellOf(img.rank);
    const cx = col * CELL + CELL / 2;
    const cy = row * CELL + CELL / 2;
    const next: OrthographicViewState = {
      ...(viewStateRef.current ?? {}),
      target: [cx, cy, 0],
    };
    viewStateRef.current = next;
    deckRef.current.setProps({ viewState: next });
    forceRender((n) => n + 1);
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
    const copyGroup: MenuItem[] = [
      {
        label: 'Copy to another board…',
        onSelect: () => {},
        disabled: true,
        disabledReason: 'Not built yet.',
      },
      {
        label: 'Download',
        onSelect: () => {},
        disabled: true,
        disabledReason: 'Not built yet.',
      },
    ];
    return [exploreGroup, sheetGroup, openGroup, propsGroup, copyGroup];
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
    await refreshSheets();
    notifySheetsChanged();
  }

  async function renameSheet(sheetId: string, name: string) {
    await api.updateSheet(sheetId, { name });
    await refreshSheets();
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
          onOpenWeb={async (relation) => {
            // Every picture the relation joins (find, alias-aware), then
            // one step of that relation from each: at most WEB_STARTS.
            const found = await api
              .findBoard(boardId, currentSortId, '', [], { relation })
              .catch(() => null);
            const ids = found?.imageIds.slice(0, WEB_STARTS) ?? [];
            if (!ids.length) return;
            setWebRelation(relation);
            setWebRoots(ids);
          }}
        />

        <section className="board-panel-section">
          <header className="board-panel-heading">
            <h2>
              Sheets <span className="board-panel-count">{sheets.length}</span>
            </h2>
            <ThreadBrowser
              groupId={board.groupId}
              boardId={boardId}
              onChanged={refreshSheets}
            />
          </header>
          {sheets.length === 0 ? (
            <p className="board-empty-note">
              Select images on the map, then start a sheet to arrange them
              together.
            </p>
          ) : (
            <ul data-testid="sheet-list" className="board-sheet-list">
              {sheets.map((sheet) => (
                <li
                  key={sheet.id}
                  data-testid="sheet-list-item"
                  className="board-sheet-row"
                >
                  <div className="board-sheet-copy">
                    <RenameInline
                      name={sheet.name}
                      onRename={(name) => renameSheet(sheet.id, name)}
                      testId={`sheet-rename-${sheet.id}`}
                    />
                    <span className="board-sheet-meta">
                      {plural(sheet.imageCount, 'image')} ·{' '}
                      {sheet.savedAt ? savedLabel(sheet.savedAt) : 'Not saved'}
                    </span>
                  </div>
                  <div className="board-sheet-actions">
                    <button
                      type="button"
                      className="board-quiet-button"
                      data-testid={`sheet-select-${sheet.id}`}
                      title="Select this sheet's images on the map"
                      onClick={() => void selectSheetImages(sheet.id)}
                    >
                      Select
                    </button>
                    <Link className="board-sheet-open" to={`/s/${sheet.id}`}>
                      Open
                    </Link>
                    <button
                      type="button"
                      className="board-icon-button board-icon-button--danger"
                      data-testid={`sheet-delete-${sheet.id}`}
                      aria-label={`Delete sheet ${sheet.name}`}
                      title="Delete sheet"
                      onClick={() => void openSheetDeleteConfirm(sheet.id)}
                    >
                      <Icon name="trash" size={16} />
                    </button>
                  </div>
                  {sheetDeleteConfirm?.sheetId === sheet.id && (
                    <Confirm
                      testId={`sheet-delete-confirm-${sheet.id}`}
                      message={sheetDeleteMessage(
                        sheet.name,
                        sheetDeleteConfirm.footprint,
                      )}
                      busy={sheetDeleteBusy}
                      error={sheetDeleteError}
                      onConfirm={() => void confirmDeleteSheet()}
                      onCancel={() => setSheetDeleteConfirm(null)}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="board-panel-section">
          <header className="board-panel-heading">
            <h2>Board</h2>
          </header>
          <div className="board-about">
            <span className="board-open-status" data-open={board.open}>
              <span aria-hidden="true" />
              {board.open ? 'Open to the whole group' : 'Private board'}
            </span>
            <button
              type="button"
              className="board-danger-link"
              data-testid="board-delete"
              onClick={() => void openBoardDeleteConfirm()}
            >
              Delete board
            </button>
          </div>
          {boardDeleteConfirm && (
            <Confirm
              testId="board-delete-confirm"
              message={boardDeleteMessage(board.name, boardDeleteConfirm)}
              busy={boardDeleteBusy}
              error={boardDeleteError}
              onConfirm={() => void confirmDeleteBoard()}
              onCancel={() => setBoardDeleteConfirm(null)}
            />
          )}

          {!board.open && (
            <div className="board-allowlist" data-testid="allowlist-card">
              <h3>Allowlist</h3>
              {allowlistError && <div className="error">{allowlistError}</div>}
              <ul data-testid="allowlist-table">
                {(allowlist?.members ?? []).map((m) => (
                  <li key={m.userId} className="board-allowlist-row">
                    <span className="board-allowlist-name">{m.name}</span>
                    <span className="board-allowlist-role">{m.role}</span>
                    <button
                      type="button"
                      className="board-quiet-button"
                      data-testid={`allowlist-remove-${m.userId}`}
                      aria-label={`Remove ${m.name} from the allowlist`}
                      onClick={() => void removeFromAllowlist(m.userId)}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
              <div className="board-allowlist-add">
                <select
                  data-testid="allowlist-add-select"
                  aria-label="Member to add"
                  value={allowlistPick}
                  onChange={(e) => setAllowlistPick(e.target.value)}
                >
                  <option value="">Choose a member…</option>
                  {groupMembers
                    .filter(
                      (m) =>
                        !(allowlist?.members ?? []).some(
                          (x) => x.userId === m.userId,
                        ),
                    )
                    .map((m) => (
                      <option key={m.userId} value={m.userId}>
                        {m.email}
                      </option>
                    ))}
                </select>
                <button
                  type="button"
                  data-testid="allowlist-add"
                  disabled={!allowlistPick}
                  onClick={() => {
                    const userId = allowlistPick;
                    setAllowlistPick('');
                    if (userId) void addToAllowlist(userId);
                  }}
                >
                  Add
                </button>
              </div>
            </div>
          )}
        </section>
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
