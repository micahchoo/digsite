// The map: deck.gl OrthographicView + TileLayer over the server's tile
// pyramid (docs/design.md "web/", `/b/:id`). Imperative deck.gl, matching
// ../../../prototype/board/viewer/src/main.ts's pattern — the tile-index ->
// URL mapping was verified there against deck.gl's tileset-2d source and is
// reused unchanged: deck's {x,y,z} is the server's {z}/{x}/{y} verbatim.
//
// Phase 1 section 3 (docs/phases/1-map.md) adds sections, hover, selection
// and detail on top of that skeleton. Every new piece of state that affects
// what's drawn (sections, the selected ranks, zoom) feeds one `layers`
// memo, pushed to the Deck instance in one effect — the TileLayer stays the
// single source of tiles, the rest are plain overlays on top of it, never
// baked into a tile (../.claude/rules/ladder-slot-vs-rank.md: "A pin or a
// selection on the map is a client overlay").
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
  CELL,
  COLS,
  DEFAULT_SORT,
  type GetImageResponse,
  type Properties,
  type PropertyValue,
  SHEET_LIMIT,
  type Section,
  type Sort,
  type SortKey,
  parseSortId,
  rankAtWorld,
  sortId,
  worldExtent,
} from '@digsite/shared';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Detail } from '../board/Detail.tsx';
import { Explore } from '../board/Explore.tsx';
import { boardDeleteMessage, sheetDeleteMessage } from '../board/messages.ts';
import { sectionMarkers, sectionsVisible } from '../board/sections-layer.ts';
import {
  addRanks,
  cellPolygon,
  rankRange,
  toggleRank,
} from '../board/selection.ts';
import { type UploadRow, runUpload } from '../board/upload.ts';
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

declare global {
  interface Window {
    __digsiteBoard?: {
      setZoom: (z: number) => void;
      getSelection: () => number[];
      select: (rank: number) => void;
      selectRange: (a: number, b: number) => void;
      clear: () => void;
      getLayerIds: () => string[];
      // Phase 2 section 4 (docs/phases/2-sheet.md): Explore.tsx's
      // "the result becomes the map selection" — resolves ranks through
      // ONE `GET /boards/:id/images?ids=` call (lib/api.ts's
      // `getBoardImagesByIds`; not on the real server yet, see that
      // file's header comment). Falls back to marking the selection by
      // id in the side panel only when the server has no ranks to give
      // back (the endpoint is missing, or answers with none).
      selectImages: (ids: string[]) => void;
    };
  }
}

const MIN_ZOOM = -5;
const MAX_ZOOM = 0;
const TILE_SIZE = 256;
const SELECTION_COLOR: [number, number, number, number] = [255, 90, 0, 255];
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
 */
function fitInitialViewState(
  count: number,
  worldH: number,
): OrthographicViewState {
  const contentW = Math.min(Math.max(count, 1), COLS) * CELL;
  const w = window.innerWidth;
  const h = window.innerHeight - 200;
  const zoomX = Math.log2(w / contentW);
  const zoomY = Math.log2(h / worldH);
  const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.min(zoomX, zoomY)));
  return {
    target: [contentW / 2, worldH / 2, 0],
    zoom,
    minZoom: MIN_ZOOM,
    maxZoom: MAX_ZOOM,
  };
}

/** Per-sort cache of rank -> image (or null for an empty/failed lookup),
 * shared between hover and the selection panel so a rank fetched once by
 * either is never re-fetched by the other. */
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

export function Board() {
  const { id } = useParams<{ id: string }>();
  const boardId = id ?? '';
  const navigate = useNavigate();

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
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
  const [sheetName, setSheetName] = useState('');
  const [, forceRender] = useState(0);

  // -- sections --------------------------------------------------------------
  const [sections, setSections] = useState<Section[]>([]);
  const [sectionsTruncated, setSectionsTruncated] = useState(false);

  // -- hover -------------------------------------------------------------------
  const hoverTimerRef = useRef<number | null>(null);
  const imageCacheRef = useRef<Map<string, Map<number, BoardImage | null>>>(
    new Map(),
  );
  const [hoverTooltip, setHoverTooltip] = useState<HoverTooltip | null>(null);

  // -- selection ---------------------------------------------------------------
  const [selectedRanks, setSelectedRanks] = useState<Set<number>>(new Set());
  const selectedRanksRef = useRef(selectedRanks);
  selectedRanksRef.current = selectedRanks;
  const [selectedImages, setSelectedImages] = useState<BoardImage[]>([]);
  const [selectionNote, setSelectionNote] = useState('');
  const shiftHeldRef = useRef(false);
  const shiftDragRef = useRef<{ startRank: number } | null>(null);

  // -- detail ------------------------------------------------------------------
  const [detailImage, setDetailImage] = useState<GetImageResponse | null>(null);
  const [detailSaveState, setDetailSaveState] = useState<
    'idle' | 'saving' | 'saved' | 'error'
  >('idle');

  // -- upload ------------------------------------------------------------------
  const [uploadRows, setUploadRows] = useState<UploadRow[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadNote, setUploadNote] = useState('');

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
  // every function there closes over refs so it never goes stale), and
  // `selectImagesById` needs the CURRENT boardId/sort at call time.
  const boardIdRef = useRef(boardId);
  boardIdRef.current = boardId;
  const currentSortIdRef = useRef(currentSortId);
  currentSortIdRef.current = currentSortId;

  // Explore.tsx's "the result becomes the map selection" (docs/phases/2-sheet.md
  // section 4): resolves ranks through ONE `GET /boards/:id/images?ids=`
  // call (lib/api.ts's getBoardImagesByIds — a param the real server
  // doesn't have yet, see that file's header comment). When the server
  // gives back no ranks at all (the param is unsupported, or every id came
  // back rank-less), falls back to marking the selection by id in the side
  // panel only, per the task's own fallback.
  //
  // `mode` (docs/ux/audit.md #6): 'replace' is the original behaviour and
  // every existing caller's default (`window.__digsiteBoard.selectImages`
  // included, so smoke-explore.ts and the ux-audit repro scripts are
  // unaffected); Explore.tsx passes 'add' only after the owner picks "Add
  // to selection" on its own confirm, never silently.
  const selectImagesById = useCallback(
    async (ids: string[], mode: 'replace' | 'add' = 'replace') => {
      if (!ids.length) return;
      try {
        const { images: found } = await api.getBoardImagesByIds(
          boardIdRef.current,
          currentSortIdRef.current,
          ids,
        );
        const cache = sortCache(
          imageCacheRef.current,
          currentSortIdRef.current,
        );
        const ranks: number[] = [];
        for (const img of found) {
          if (typeof img.rank === 'number') {
            ranks.push(img.rank);
            cache.set(img.rank, img);
          }
        }
        if (ranks.length) {
          setSelectedRanks((prev) =>
            mode === 'add' ? addRanks(prev, ranks) : new Set(ranks),
          );
        } else {
          // No rank came back for anything (the `ids` param isn't honoured,
          // or nothing matched under this sort) — mark the selection by id
          // in the side panel only. Deliberately does NOT touch
          // `selectedRanks`: that state drives the map's own polygon
          // overlay AND the effect that re-derives `selectedImages` from
          // it, so clearing it here would have that effect overwrite this
          // fallback moments later with an empty list.
          setSelectedImages((prev) => {
            if (mode !== 'add') return found;
            const byId = new Map(prev.map((i) => [i.id, i]));
            for (const img of found) byId.set(img.id, img);
            return [...byId.values()];
          });
        }
      } catch {
        // the ids param isn't supported by this server; nothing to select
      }
    },
    [],
  );

  function changeSort(next: Sort) {
    setSort(next);
    localStorage.setItem(storageKey(boardId), sortId(next));
  }

  // -- deck.gl mount, once ---------------------------------------------------
  useEffect(() => {
    if (!canvasRef.current || !board) return;
    if (deckRef.current) return;
    const [, , , h] = worldExtent(board.imageCount);
    viewStateRef.current = fitInitialViewState(board.imageCount, h);
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
      onClick: (info) => handleClick(info),
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
        commitRangeSelection(drag.startRank, endRank);
      },
    });
    return () => {
      deckRef.current?.finalize();
      deckRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board]);

  // -- shift toggles the controller's drag-to-pan off, so a shift-drag can
  // become a range selection instead of a pan. Set proactively on keydown,
  // before the gesture starts, so there's no race with the first pan tick. --
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

  // -- Escape closes the detail panel -----------------------------------------
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setDetailImage(null);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // A debug-only hook for the smoke script's screenshots — NOT part of the
  // fixed window.__digsite contract (that is sheet-only, see sheet/tools.ts).
  // Assigned once: every function here closes over refs or stable setters,
  // never a piece of state directly, so it never goes stale.
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
        Array.from(selectedRanksRef.current).sort((a, b) => a - b),
      select: (rank: number) =>
        setSelectedRanks((prev) => toggleRank(prev, rank)),
      selectRange: (a: number, b: number) => commitRangeSelection(a, b),
      clear: () => setSelectedRanks(new Set()),
      getLayerIds: () =>
        ((deckRef.current?.props.layers ?? []) as { id?: string }[])
          .map((l) => l?.id)
          .filter((x): x is string => !!x),
      selectImages: (ids: string[]) => void selectImagesById(ids),
    };
    // selectImagesById is itself a stable useCallback (empty deps, reads
    // boardId/currentSortId through refs) — including it here costs
    // nothing and keeps this effect honest with the linter, per this
    // effect's own "every function here closes over refs or stable
    // setters" comment above.
  }, [selectImagesById]);

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

    if (selectedRanks.size) {
      const polygons = Array.from(selectedRanks, (rank) => cellPolygon(rank));
      list.push(
        new PolygonLayer({
          id: 'selection-outline',
          data: polygons,
          getPolygon: (d) => d,
          stroked: true,
          filled: false,
          getLineColor: SELECTION_COLOR,
          getLineWidth: 2,
          lineWidthUnits: 'pixels',
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
    selectedRanks,
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
    const cache = sortCache(imageCacheRef.current, currentSortId);
    if (cache.has(rank)) {
      const image = cache.get(rank) ?? null;
      setHoverTooltip(image ? { x, y, rank, image } : null);
      return;
    }
    try {
      const { images } = await api.listBoardImages(
        boardId,
        currentSortId,
        rank,
        1,
      );
      const image = images[0] ?? null;
      cache.set(rank, image);
      setHoverTooltip(image ? { x, y, rank, image } : null);
    } catch {
      // the pointer likely moved on already; nothing to show
    }
  }

  // -- selection ---------------------------------------------------------------
  function handleClick(info: PickingInfo) {
    const b = boardRef.current;
    if (!b || !info.coordinate) return;
    const [wx, wy] = info.coordinate as [number, number];
    const rank = rankAtWorld(wx, wy);
    if (rank < 0 || rank >= b.imageCount) {
      setClickInfo(`rank ${rank} — empty`);
      return;
    }
    setClickInfo(`rank ${rank} toggled`);
    setSelectedRanks((prev) => toggleRank(prev, rank));
  }

  function commitRangeSelection(a: number, b: number) {
    const { ranks, truncated } = rankRange(a, b, SHEET_LIMIT);
    setSelectedRanks((prev) => addRanks(prev, ranks));
    setSelectionNote(
      truncated ? `selection capped at ${plural(SHEET_LIMIT, 'image')}` : '',
    );
  }

  // -- resolve selected ranks to images for the side panel --------------------
  useEffect(() => {
    let cancelled = false;
    async function load() {
      const b = boardRef.current;
      const cache = sortCache(imageCacheRef.current, currentSortId);
      const ranks = Array.from(selectedRanks);
      const missing = ranks.filter((r) => !cache.has(r));
      await Promise.all(
        missing.map(async (r) => {
          if (!b || r < 0 || r >= b.imageCount) {
            cache.set(r, null);
            return;
          }
          try {
            const { images } = await api.listBoardImages(
              boardId,
              currentSortId,
              r,
              1,
            );
            cache.set(r, images[0] ?? null);
          } catch {
            cache.set(r, null);
          }
        }),
      );
      if (cancelled) return;
      const list = ranks
        .map((r) => cache.get(r))
        .filter((img): img is BoardImage => !!img);
      setSelectedImages(list);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [selectedRanks, currentSortId, boardId]);

  function clearSelection() {
    setSelectedRanks(new Set());
    setSelectionNote('');
  }

  // -- detail ------------------------------------------------------------------
  function openDetail(imageId: string) {
    void api.getImage(imageId).then((img) => {
      setDetailImage(img);
      setDetailSaveState('idle');
    });
  }

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
  // copy of this image (hover, the selection panel) is patched in place so
  // the dimmed "missing" state shows without a full reload. The sheet's own
  // missing-placeholder handling is in sheet/Sheet.tsx's `loadImages`. -----
  async function deleteDetailImage() {
    if (!detailImage) return;
    const imageId = detailImage.id;
    try {
      await api.deleteImage(imageId);
    } catch {
      setDetailSaveState('error');
      return;
    }
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
  async function handleFiles(files: FileList | null) {
    if (!files || !files.length || !board) return;
    setUploading(true);
    setUploadNote('');
    const result = await runUpload(boardId, Array.from(files), setUploadRows);
    setUploading(false);
    if (result.timedOut) {
      setUploadNote('upload: still processing after 60s — tiles will catch up');
    }
    const fresh = await api.getBoard(boardId);
    setBoard(fresh);
    setTileVersion((n) => n + 1);
  }

  async function createSheetFromSelection(e: React.FormEvent) {
    e.preventDefault();
    if (!sheetName.trim() || !selectedImages.length) return;
    const { id: newId } = await api.createSheet(boardId, {
      name: sheetName.trim(),
      imageIds: selectedImages.map((i) => i.id),
    });
    navigate(`/s/${newId}`);
  }

  async function renameSheet(id: string, name: string) {
    await api.updateSheet(id, { name });
    await refreshSheets();
  }

  if (boardError) return <ErrorState info={boardError} />;
  if (!board) return <div className="page">loading…</div>;

  const s = statusRef.current;
  const cacheRatio =
    s.cacheTotal === 0
      ? '-'
      : `${((s.cacheHits / s.cacheTotal) * 100).toFixed(1)}%`;

  return (
    // Fills the shell's page outlet (shell/shell.css's `.shell-page`) —
    // no bare top nav to subtract anymore (docs/ux/design.md §3).
    <div style={{ display: 'flex', height: '100%' }}>
      <div style={{ flex: 1, position: 'relative' }}>
        <canvas
          ref={canvasRef}
          style={{ width: '100%', height: '100%', display: 'block' }}
        />
        <div className="status-line" data-testid="status">
          zoom={s.zoom.toFixed(2)} tiles={s.tilesRequested} cache={cacheRatio}{' '}
          ttft=
          {s.ttftMs === null ? '-' : `${s.ttftMs.toFixed(0)}ms`}
          {sectionsTruncated ? ' · sections truncated at 500' : ''}
        </div>
        <div className="row" style={{ position: 'absolute', top: 8, left: 8 }}>
          <select
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
              <option key={JSON.stringify(k.key)} value={JSON.stringify(k.key)}>
                {k.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            data-testid="sort-dir"
            onClick={() =>
              changeSort({ ...sort, dir: sort.dir === 'asc' ? 'desc' : 'asc' })
            }
          >
            {sort.dir}
          </button>
          <label className="row" style={{ margin: 0 }}>
            <input
              data-testid="upload-input"
              type="file"
              multiple
              disabled={uploading}
              onChange={(e) => void handleFiles(e.target.files)}
            />
          </label>
        </div>
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
        {uploadRows.length > 0 && (
          <div
            data-testid="upload-rows"
            style={{
              position: 'absolute',
              top: 40,
              left: 8,
              background: 'rgba(255,255,255,0.95)',
              border: '1px solid #ccc',
              borderRadius: 4,
              padding: 6,
              fontSize: 12,
              maxWidth: 260,
            }}
          >
            {uploadRows.map((r) => (
              <div
                key={r.clientId}
                className="row"
                data-testid="upload-row"
                data-status={r.status}
                style={{ margin: '2px 0' }}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {r.file.name}
                </span>
                <span className="muted">
                  {r.method}
                  {r.method === 'tus' && r.status === 'uploading'
                    ? ` ${r.progress}%`
                    : ''}
                </span>
                <span className="muted">{r.status}</span>
              </div>
            ))}
            {uploadNote && <div className="muted">{uploadNote}</div>}
          </div>
        )}
      </div>
      <div className="board-side">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <RenameInline
            name={board.name}
            onRename={renameBoard}
            testId="board-rename"
            style={{ fontSize: 18, fontWeight: 700 }}
          />
          <button
            type="button"
            data-testid="board-delete"
            onClick={() => void openBoardDeleteConfirm()}
          >
            delete board
          </button>
        </div>
        <div className="muted">{plural(board.imageCount, 'image')}</div>
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

        <h4>selection ({selectedImages.length})</h4>
        {selectionNote && <div className="muted">{selectionNote}</div>}
        <ul
          data-testid="selection-list"
          style={{ listStyle: 'none', padding: 0 }}
        >
          {selectedImages.map((i) => (
            <li key={i.id}>
              <button
                type="button"
                data-testid="selection-item"
                data-missing={i.missing}
                onClick={() => openDetail(i.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  width: '100%',
                  textAlign: 'left',
                  background: 'none',
                  border: 'none',
                  padding: '2px 0',
                  opacity: i.missing ? 0.5 : 1,
                }}
              >
                {i.missing ? (
                  <span
                    style={{
                      width: 28,
                      height: 28,
                      display: 'inline-block',
                      background: '#eee',
                    }}
                  />
                ) : (
                  <img
                    src={api.originalUrl(i.id)}
                    alt=""
                    style={{ width: 28, height: 28, objectFit: 'cover' }}
                  />
                )}
                {i.name}
                {i.missing ? ' (missing)' : ''}
              </button>
            </li>
          ))}
        </ul>
        <div className="row">
          <button
            type="button"
            data-testid="clear-selection"
            onClick={clearSelection}
            disabled={!selectedImages.length}
          >
            Clear
          </button>
        </div>
        <form onSubmit={(e) => void createSheetFromSelection(e)}>
          <input
            data-testid="sheet-name"
            placeholder="new sheet name"
            value={sheetName}
            onChange={(e) => setSheetName(e.target.value)}
          />
          <button type="submit" disabled={!selectedImages.length}>
            new sheet
          </button>
        </form>

        <h4>sheets ({sheets.length})</h4>
        <ul data-testid="sheet-list" style={{ listStyle: 'none', padding: 0 }}>
          {sheets.map((sheet) => (
            <Fragment key={sheet.id}>
              <li
                data-testid="sheet-list-item"
                style={{
                  display: 'flex',
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
                <Link to={`/s/${sheet.id}`}>open</Link>
                <button
                  type="button"
                  data-testid={`sheet-delete-${sheet.id}`}
                  onClick={() => void openSheetDeleteConfirm(sheet.id)}
                >
                  delete
                </button>
              </li>
              {sheetDeleteConfirm?.sheetId === sheet.id && (
                <li>
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
                </li>
              )}
            </Fragment>
          ))}
        </ul>

        {detailImage && (
          <Detail
            image={detailImage}
            originalUrl={api.originalUrl(detailImage.id)}
            saveState={detailSaveState}
            onSetProperty={setDetailProperty}
            onRemoveProperty={removeDetailProperty}
            onDelete={() => void deleteDetailImage()}
            onClose={() => setDetailImage(null)}
          />
        )}
        {detailImage && !detailImage.missing && (
          <Explore
            boardId={boardId}
            imageId={detailImage.id}
            currentSelectionCount={selectedImages.length}
            onSelectImages={selectImagesById}
          />
        )}
      </div>
    </div>
  );
}
