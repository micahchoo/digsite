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
  type FindFilterClause,
  type GetImageResponse,
  type Properties,
  type PropertyValue,
  SHEET_LIMIT,
  type Section,
  type Sort,
  type SortKey,
  cellOf,
  parseSortId,
  rankAtWorld,
  sortId,
  worldExtent,
} from '@digsite/shared';
import {
  useCallback,
  useEffect,
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
import { Detail } from '../board/Detail.tsx';
import { Explore } from '../board/Explore.tsx';
import { ThreadBrowser } from '../board/ThreadBrowser.tsx';
import { Tray } from '../board/Tray.tsx';
import { UploadActivity } from '../board/UploadActivity.tsx';
import { ZoomControl, zoomIn, zoomOut } from '../board/ZoomControl.tsx';
import { boardDeleteMessage, sheetDeleteMessage } from '../board/messages.ts';
import { sectionMarkers, sectionsVisible } from '../board/sections-layer.ts';
import { cellPolygon } from '../board/selection.ts';
import {
  enqueueUploads,
  getUploadSnapshot,
  subscribeUploadQueue,
} from '../board/upload.ts';
import { useSelection } from '../board/useSelection.ts';
import '../board/board.css';
import { Confirm } from '../components/Confirm.tsx';
import {
  ErrorState,
  type ErrorStateInfo,
  fromCaught,
} from '../components/ErrorState.tsx';
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
import { useRightColumn } from '../shell/RightColumn.tsx';

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
      getLayerIds: () => string[];
      // Phase 2 section 4 (docs/phases/2-sheet.md): Explore.tsx's
      // "the result becomes the map selection" — resolves ranks through
      // ONE `GET /boards/:id/images?ids=` call (lib/api.ts's
      // `getBoardImagesByIds`).
      selectImages: (ids: string[], mode?: 'replace' | 'add') => void;
    };
  }
}

const MIN_ZOOM = -5;
const MAX_ZOOM = 0;
const TILE_SIZE = 256;
const SELECTION_COLOR: [number, number, number, number] = [255, 90, 0, 255];
const FLASH_COLOR: [number, number, number, number] = [79, 93, 255, 255];
const SECTION_LINE_COLOR: [number, number, number, number] = [30, 30, 30, 160];
const SECTION_TEXT_COLOR: [number, number, number, number] = [20, 20, 20, 230];

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

/**
 * `worldExtent(count)` is the shared tiling boundary the TileLayer needs —
 * COLS wide however few images there are, so a sparse board's grid still
 * has 1024 columns of (mostly empty) space. Fitting THAT full width would
 * center the initial view on empty tiles for any board short of ~1024
 * images. Fit the box the images actually occupy instead: width capped to
 * what a single row holds, height from the row count `worldExtent` already
 * computed.
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
): OrthographicViewState {
  const contentW = Math.min(Math.max(count, 1), COLS) * CELL;
  const w = window.innerWidth;
  const h = window.innerHeight - 200;
  const zoomX = Math.log2(w / contentW);
  const zoomY = Math.log2(h / worldH);
  let zoom = Math.min(zoomX, zoomY);
  const zoomFloor = Math.log2(MIN_INITIAL_CELL_PX / CELL);
  zoom = Math.max(zoom, zoomFloor);
  zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
  return {
    target: [contentW / 2, worldH / 2, 0],
    zoom,
    minZoom: MIN_ZOOM,
    maxZoom: MAX_ZOOM,
  };
}

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
  const [clickInfo, setClickInfo] = useState<string>('');
  const [, forceRender] = useState(0);

  // -- sections --------------------------------------------------------------
  const [sections, setSections] = useState<Section[]>([]);
  const [sectionsTruncated, setSectionsTruncated] = useState(false);
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
  const [selectedImages, setSelectedImages] = useState<BoardImageWithRank[]>(
    [],
  );
  const selectedImagesRef = useRef<BoardImageWithRank[]>([]);
  selectedImagesRef.current = selectedImages;
  const [selectionNote, setSelectionNote] = useState('');
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [filterKey, setFilterKey] = useState('');
  const [filterOp, setFilterOp] = useState<'eq' | 'gte' | 'lte'>('eq');
  const [filterValue, setFilterValue] = useState('');
  const [findFilters, setFindFilters] = useState<FindFilterClause[]>([]);
  const [findResult, setFindResult] = useState<{
    ranks: number[];
    imageIds: string[];
    count: number;
  } | null>(null);
  const [findError, setFindError] = useState('');
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
  const uploading =
    uploadSnapshot.counts.queued > 0 || uploadSnapshot.counts.uploading > 0;
  const lastUploadRefreshRef = useRef(0);

  useEffect(() => {
    if (!uploadSnapshot.refreshVersion) return;
    let cancelled = false;
    const delay = Math.max(
      0,
      1200 - (Date.now() - lastUploadRefreshRef.current),
    );
    const timer = window.setTimeout(() => {
      lastUploadRefreshRef.current = Date.now();
      void api
        .getBoard(boardId)
        .then((fresh) => {
          if (cancelled) return;
          setBoard(fresh);
          setTileVersion((value) => value + 1);
        })
        .catch(() => {});
    }, delay);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [boardId, uploadSnapshot.refreshVersion]);

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

  const currentSortId = sort ? sortId(sort) : DEFAULT_SORT.key.toString();

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
    async (a: number, b: number) => {
      try {
        const { imageIds } = await api.postSelectionRange(boardIdRef.current, {
          sort: currentSortIdRef.current,
          fromRank: a,
          toRank: b,
        });
        selection.add(imageIds);
        const span = Math.abs(b - a) + 1;
        setSelectionNote(
          imageIds.length > 0 && imageIds.length < span
            ? `selection capped at ${plural(imageIds.length, 'image')}`
            : '',
        );
      } catch {
        // range endpoint unreachable this tick; nothing selected
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
    viewStateRef.current = fitInitialViewState(board.imageCount, h);
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
        shiftDragRef.current = { startRank: rankAtWorld(wx, wy) };
        event.srcEvent?.preventDefault?.();
      },
      onDragEnd: (info) => {
        const drag = shiftDragRef.current;
        shiftDragRef.current = null;
        if (!drag || !info.coordinate) return;
        const [wx, wy] = info.coordinate as [number, number];
        const endRank = rankAtWorld(wx, wy);
        void rangeSelect(drag.startRank, endRank);
      },
    });
    return () => {
      deckRef.current?.finalize();
      deckRef.current = null;
    };
  }, [board]);

  // -- "Show on board" (design.md §5.1: a sheet's own top bar returns here
  // with the sheet's images selected, the map scrolled to the first) — a
  // `?showSheet=<id>` query param, consumed once and stripped from the URL.
  // Only meant to re-run when the BOARD loads/changes — `searchParams`/
  // `setSearchParams` are read and written, not reacted to; including them
  // would re-fire this on every OTHER query-param change too.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
  useEffect(() => {
    const sheetIdParam = searchParams.get('showSheet');
    if (!sheetIdParam || !board) return;
    void showSheetOnBoard(sheetIdParam);
    const next = new URLSearchParams(searchParams);
    next.delete('showSheet');
    setSearchParams(next, { replace: true });
  }, [board]);

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
      getLayerIds: () =>
        ((deckRef.current?.props.layers ?? []) as { id?: string }[])
          .map((l) => l?.id)
          .filter((x): x is string => !!x),
      selectImages: (ids: string[], mode: 'replace' | 'add' = 'replace') => {
        if (mode === 'add') selection.add(ids);
        else selection.replace(ids);
      },
    };
  }, [resolveImageAtRank, rangeSelect, selection]);

  // -- sections: refetch on sort change -----------------------------------
  useEffect(() => {
    let cancelled = false;
    setSections([]);
    setSectionsTruncated(false);
    if (!board) return;
    void api
      .getSections(boardId, currentSortId)
      .then((res) => {
        if (cancelled) return;
        setSections(res.sections);
        setSectionsTruncated(res.truncated);
      })
      .catch(() => {
        // sections route not reachable this tick; the map still works
        // without labels.
      });
    return () => {
      cancelled = true;
    };
  }, [board, boardId, currentSortId]);

  // Search and typed property filters use the current rank table. Debounce
  // keystrokes and discard any response for criteria that are now stale.
  useEffect(() => {
    if (!findOpen || (!findQuery.trim() && !findFilters.length)) {
      setFindResult(null);
      setFindError('');
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void api
        .findBoard(boardId, currentSortId, findQuery.trim(), findFilters)
        .then((result) => {
          if (!cancelled) {
            setFindResult(result);
            setFindError('');
          }
        })
        .catch((err: unknown) => {
          if (!cancelled) {
            setFindResult(null);
            setFindError(err instanceof Error ? err.message : 'Search failed');
          }
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [boardId, currentSortId, findOpen, findQuery, findFilters]);

  // -- hover tooltip goes stale across a sort change (the rank means a
  // different image) --------------------------------------------------------
  useEffect(() => {
    setHoverTooltip(null);
  }, []);

  // -- fetch the tile ----------------------------------------------------------
  const fetchTile = useCallback(
    async (
      index: { x: number; y: number; z: number },
      signal?: AbortSignal,
    ) => {
      const url = api.tileUrl(
        boardId,
        currentSortId,
        index.z,
        index.x,
        index.y,
      );
      statusRef.current.tilesRequested++;
      forceRender((n) => n + 1);
      const res = await fetch(url, { credentials: 'include', signal });
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

  // -- resolve the selection's ids to images (with rank under the CURRENT
  // sort) whenever the ids or the sort change — the tray, the map outline,
  // fly-to and window.__digsiteBoard.getSelection() all read this. --------
  useEffect(() => {
    let cancelled = false;
    if (!selection.imageIds.length) {
      setSelectedImages([]);
      return;
    }
    void api
      .getBoardImagesByIds(boardId, currentSortId, selection.imageIds)
      .then(({ images: found }) => {
        if (cancelled) return;
        setSelectedImages(found);
      })
      .catch(() => {
        if (!cancelled) setSelectedImages([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selection.imageIds, boardId, currentSortId]);

  // -- one layers array: tiles + sections + the selection outline -----------
  const zoom = statusRef.current.zoom;
  useEffect(() => {
    if (!deckRef.current || !board) return;
    const [, , w, h] = worldExtent(board.imageCount);
    const tileLayer = new TileLayer({
      id: `board-tiles-${currentSortId}-${tileVersion}`,
      data: null,
      tileSize: TILE_SIZE,
      extent: [0, 0, w, h],
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      refinementStrategy: 'never',
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

    if (findResult?.ranks.length) {
      list.push(
        new PolygonLayer({
          id: 'find-matches',
          data: findResult.ranks.map((rank) => cellPolygon(rank)),
          getPolygon: (d) => d,
          stroked: false,
          filled: true,
          getFillColor: [79, 93, 255, 54],
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
          getColor: SECTION_LINE_COLOR,
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
          getColor: SECTION_TEXT_COLOR,
          getTextAnchor: 'start',
          getAlignmentBaseline: 'top',
          getPixelOffset: [3, 2],
          billboard: false,
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
          getLineColor: SELECTION_COLOR,
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
            getLineColor: FLASH_COLOR,
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
    if (rank < 0 || rank >= b.imageCount) {
      setClickInfo(`rank ${rank} — empty`);
      return;
    }
    setClickInfo(`rank ${rank} toggled`);
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

  function applyPropertyFilter() {
    if (!filterKey || !filterValue.trim()) return;
    const property = board?.sortableKeys.find(
      (key) => typeof key.key !== 'string' && key.key.property === filterKey,
    );
    const isNumber =
      property &&
      typeof property.key !== 'string' &&
      property.key.type === 'number';
    const value: unknown = isNumber ? Number(filterValue) : filterValue.trim();
    if (typeof value === 'number' && !Number.isFinite(value)) return;
    setFindFilters((current) => [
      ...current.filter((clause) => clause.key !== filterKey),
      { key: filterKey, op: filterOp, value },
    ]);
    setFilterValue('');
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
    const next = fitInitialViewState(board.imageCount, h);
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
    const vw = window.innerWidth;
    const vh = window.innerHeight - 200;
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
  function flyToImage(imgId: string) {
    const img = selectedImages.find((i) => i.id === imgId);
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
    setSelectedImages((prev) =>
      prev.map((i) => (i.id === imageId ? { ...i, missing: true } : i)),
    );
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

  // -- the right column's content (design.md §3.4/§7 slice 2: "move
  // Board.tsx's inline side panel into the shell's right column"). --------
  useRightColumn(
    board && (
      <div className="board-right" data-testid="board-side">
        <div className="board-inspector-heading">
          <div className="board-inspector-title-row">
            <span className="board-inspector-label">Board access</span>
            <button
              type="button"
              className="board-icon-button board-delete-button"
              data-testid="board-delete"
              aria-label="Delete board"
              title="Delete board"
              onClick={() => void openBoardDeleteConfirm()}
            >
              <svg aria-hidden="true" viewBox="0 0 20 20">
                <path d="M4.5 5.5h11M8 5.5V4h4v1.5m2.5 0-.7 10.2a1.5 1.5 0 0 1-1.5 1.3H7.7a1.5 1.5 0 0 1-1.5-1.3L5.5 5.5m3 3v5m3-5v5" />
              </svg>
            </button>
          </div>
          <div className="board-inspector-meta">
            <span className="board-open-status">
              <span aria-hidden="true" />
              {board.open ? 'Shared with group' : 'Private board'}
            </span>
            <span>{plural(board.imageCount, 'image')}</span>
          </div>
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
          <div className="card" data-testid="allowlist-card">
            <h4>allowlist</h4>
            {allowlistError && <div className="error">{allowlistError}</div>}
            <table data-testid="allowlist-table">
              <tbody>
                {(allowlist?.members ?? []).map((m) => (
                  <tr key={m.userId}>
                    <td>{m.name}</td>
                    <td className="muted">{m.role}</td>
                    <td>
                      <button
                        type="button"
                        data-testid={`allowlist-remove-${m.userId}`}
                        onClick={() => void removeFromAllowlist(m.userId)}
                      >
                        remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="row">
              <select
                data-testid="allowlist-add-select"
                value={allowlistPick}
                onChange={(e) => setAllowlistPick(e.target.value)}
              >
                <option value="">add member…</option>
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
                add
              </button>
            </div>
          </div>
        )}

        <section className="board-inspector-section board-sheets-section">
          <div className="board-section-heading">
            <div>
              <span className="board-eyebrow">WORKSPACES</span>
              <h4>
                Sheets <span>{sheets.length}</span>
              </h4>
            </div>
            <ThreadBrowser
              groupId={board.groupId}
              boardId={boardId}
              onChanged={refreshSheets}
            />
          </div>
          <ul
            data-testid="sheet-list"
            className="board-sheet-list"
            style={{ listStyle: 'none', padding: 0 }}
          >
            {sheets.map((sheet) => (
              <li
                key={sheet.id}
                data-testid="sheet-list-item"
                className="board-sheet-row"
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 6,
                  padding: '3px 0',
                }}
              >
                <RenameInline
                  name={sheet.name}
                  onRename={(name) => renameSheet(sheet.id, name)}
                  testId={`sheet-rename-${sheet.id}`}
                />
                <span className="muted" style={{ fontSize: 12 }}>
                  {plural(sheet.imageCount, 'image')} ·{' '}
                  {sheet.savedAt
                    ? new Date(sheet.savedAt).toLocaleTimeString()
                    : 'unsaved'}
                </span>
                <Link className="board-sheet-open" to={`/s/${sheet.id}`}>
                  Open <span aria-hidden="true">↗</span>
                </Link>
                <button
                  type="button"
                  className="board-sheet-select"
                  data-testid={`sheet-select-${sheet.id}`}
                  title="Select everything on this sheet"
                  onClick={() => void selectSheetImages(sheet.id)}
                >
                  select
                </button>
                <button
                  type="button"
                  className="board-sheet-delete"
                  data-testid={`sheet-delete-${sheet.id}`}
                  onClick={() => void openSheetDeleteConfirm(sheet.id)}
                >
                  delete
                </button>
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
          {sheets.length === 0 && (
            <p className="board-empty-note">
              Sheets gather images into a focused, collaborative thread.
            </p>
          )}
        </section>

        {detailImage && (
          <Detail
            image={detailImage}
            originalUrl={api.originalUrl(detailImage.id)}
            saveState={detailSaveState}
            onSetProperty={setDetailProperty}
            onRemoveProperty={removeDetailProperty}
            onDelete={() => void deleteDetailImage()}
            onClose={() => setFocusedImageId(null)}
          />
        )}
        {detailImage && !detailImage.missing && (
          <Explore
            boardId={boardId}
            imageId={detailImage.id}
            currentSelectionCount={selectedImages.length}
            onSelectImages={(ids, mode) => {
              if (mode === 'add') selection.add(ids);
              else selection.replace(ids ?? []);
            }}
          />
        )}
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
    <div className="board-canvas-wrap">
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
            data-testid="board-actions-button"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              openActionsMenu(rect.left, rect.bottom + 4);
            }}
          >
            <span aria-hidden="true">···</span>
          </button>
          <button
            type="button"
            className={`board-tool-button board-tool-icon${findOpen ? ' is-active' : ''}`}
            aria-label={findOpen ? 'Close find and filter' : 'Find and filter'}
            data-testid="board-find-toggle"
            onClick={() => setFindOpen((open) => !open)}
          >
            <svg aria-hidden="true" viewBox="0 0 20 20">
              <circle cx="8.6" cy="8.6" r="5.6" />
              <path d="m13 13 4 4" />
            </svg>
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
              data-testid="sort-dir"
              onClick={() =>
                changeSort({
                  ...sort,
                  dir: sort.dir === 'asc' ? 'desc' : 'asc',
                })
              }
            >
              <span aria-hidden="true">{sort.dir === 'asc' ? '↑' : '↓'}</span>
            </button>
          </div>
          <button
            type="button"
            className="board-upload-button"
            data-testid="board-upload-button"
            aria-label="Add images"
            onClick={() => fileInputRef.current?.click()}
          >
            <svg aria-hidden="true" viewBox="0 0 20 20">
              <path d="M10 13V3m0 0L6.5 6.5M10 3l3.5 3.5M4 12.5v3A1.5 1.5 0 0 0 5.5 17h9a1.5 1.5 0 0 0 1.5-1.5v-3" />
            </svg>
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
        <div className="board-find" data-testid="board-find">
          <div className="row">
            <input
              aria-label="Search image names and properties"
              data-testid="board-find-query"
              placeholder="Search names and properties"
              value={findQuery}
              onChange={(e) => setFindQuery(e.target.value)}
            />
            <select
              aria-label="Property to filter"
              data-testid="board-filter-key"
              value={filterKey}
              onChange={(e) => setFilterKey(e.target.value)}
            >
              <option value="">Property…</option>
              {board.sortableKeys.flatMap((item) =>
                typeof item.key === 'string'
                  ? []
                  : [
                      <option key={item.key.property} value={item.key.property}>
                        {item.label}
                      </option>,
                    ],
              )}
            </select>
            <select
              aria-label="Filter comparison"
              data-testid="board-filter-op"
              value={filterOp}
              onChange={(e) =>
                setFilterOp(e.target.value as 'eq' | 'gte' | 'lte')
              }
            >
              <option value="eq">is</option>
              <option value="gte">at least</option>
              <option value="lte">at most</option>
            </select>
            <input
              aria-label="Filter value"
              data-testid="board-filter-value"
              placeholder="Value"
              value={filterValue}
              onChange={(e) => setFilterValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') applyPropertyFilter();
              }}
            />
            <button
              type="button"
              data-testid="board-filter-add"
              onClick={applyPropertyFilter}
              disabled={!filterKey || !filterValue.trim()}
            >
              Add filter
            </button>
            <button
              type="button"
              data-testid="board-filter-clear"
              onClick={() => {
                setFindQuery('');
                setFindFilters([]);
              }}
            >
              Clear
            </button>
          </div>
          {findFilters.length > 0 && (
            <div className="row board-find-chips">
              {findFilters.map((clause) => (
                <button
                  type="button"
                  key={clause.key}
                  data-testid={`board-filter-chip-${clause.key}`}
                  onClick={() =>
                    setFindFilters((current) =>
                      current.filter((item) => item.key !== clause.key),
                    )
                  }
                >
                  {clause.key} {clause.op} {String(clause.value)} ×
                </button>
              ))}
            </div>
          )}
          {(findQuery.trim() || findFilters.length > 0) && (
            <div className="row board-find-result" aria-live="polite">
              {findError ? (
                <output>{findError}</output>
              ) : findResult ? (
                <>
                  <span data-testid="board-find-count">
                    {findResult.count}{' '}
                    {findResult.count === 1 ? 'match' : 'matches'}
                    {findResult.ranks.length < findResult.count
                      ? ` · showing first ${findResult.ranks.length} on map`
                      : ''}
                  </span>
                  <button
                    type="button"
                    data-testid="board-find-select-matches"
                    onClick={selectAllMatches}
                    disabled={!findResult.imageIds.length}
                  >
                    {findResult.count > findResult.imageIds.length
                      ? `Select first ${findResult.imageIds.length} of ${findResult.count}`
                      : `Select ${findResult.count} ${findResult.count === 1 ? 'match' : 'matches'}`}
                  </button>
                </>
              ) : (
                <span>Searching…</span>
              )}
            </div>
          )}
        </div>
      )}
      {clickInfo && (
        <div
          className="status-line"
          data-testid="click-info"
          style={{ bottom: 40 }}
        >
          {clickInfo}
        </div>
      )}
      {hoverTooltip && (
        <div
          className="status-line"
          data-testid="hover-tooltip"
          data-rank={hoverTooltip.rank}
          style={{
            position: 'absolute',
            left: hoverTooltip.x + 12,
            top: hoverTooltip.y + 12,
            bottom: 'auto',
            maxWidth: 220,
            pointerEvents: 'none',
          }}
        >
          <div>
            <b>{hoverTooltip.image.name}</b>
          </div>
          {Object.entries(hoverTooltip.image.properties).map(([k, v]) => (
            <div key={k}>
              {k}: {String(v)}
            </div>
          ))}
        </div>
      )}
      <UploadActivity boardId={boardId} snapshot={uploadSnapshot} />

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
        startRequested={startSheetRequested}
        onStartRequested={() => setStartSheetRequested(false)}
        addRequested={addSheetRequested}
        onAddRequested={() => setAddSheetRequested(false)}
      />

      {selectionNote && (
        <div className="status-line" style={{ bottom: 96, left: 8 }}>
          {selectionNote}
        </div>
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
