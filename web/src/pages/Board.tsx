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
  type GetBoardResponse,
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
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Detail } from '../board/Detail.tsx';
import { sectionMarkers, sectionsVisible } from '../board/sections-layer.ts';
import {
  addRanks,
  cellPolygon,
  rankRange,
  toggleRank,
} from '../board/selection.ts';
import { type UploadRow, runUpload } from '../board/upload.ts';
import { RenameInline } from '../components/RenameInline.tsx';
import { api } from '../lib/api.ts';

declare global {
  interface Window {
    __digsiteBoard?: {
      setZoom: (z: number) => void;
      getSelection: () => number[];
      select: (rank: number) => void;
      selectRange: (a: number, b: number) => void;
      clear: () => void;
      getLayerIds: () => string[];
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
  const boardRef = useRef<GetBoardResponse | null>(null);

  const [board, setBoard] = useState<GetBoardResponse | null>(null);
  boardRef.current = board;
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

  // -- load the board, then the viewer's stored or default sort ------------
  useEffect(() => {
    let cancelled = false;
    void api.getBoard(boardId).then((b) => {
      if (cancelled) return;
      setBoard(b);
      const stored = localStorage.getItem(storageKey(boardId));
      const parsed =
        (stored && parseSortId(stored)) || parseSortId(b.defaultSort);
      setSort(parsed ?? DEFAULT_SORT);
    });
    return () => {
      cancelled = true;
    };
  }, [boardId]);

  const currentSortId = sort ? sortId(sort) : DEFAULT_SORT.key.toString();

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
    };
  }, []);

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
      truncated ? `selection capped at ${SHEET_LIMIT} images` : '',
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

  if (!board) return <div className="page">loading…</div>;

  const s = statusRef.current;
  const cacheRatio =
    s.cacheTotal === 0
      ? '-'
      : `${((s.cacheHits / s.cacheTotal) * 100).toFixed(1)}%`;

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 41px)' }}>
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
      <div
        style={{
          width: 300,
          borderLeft: '1px solid #ddd',
          overflow: 'auto',
          padding: 8,
        }}
      >
        <h3>{board.name}</h3>
        <div className="muted">{board.imageCount} images</div>
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
                }}
              >
                <img
                  src={api.originalUrl(i.id)}
                  alt=""
                  style={{ width: 28, height: 28, objectFit: 'cover' }}
                />
                {i.name}
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
            <li
              key={sheet.id}
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
                {sheet.imageCount} images ·{' '}
                {sheet.savedAt
                  ? new Date(sheet.savedAt).toLocaleTimeString()
                  : 'unsaved'}
              </span>
              <Link to={`/s/${sheet.id}`}>open</Link>
            </li>
          ))}
        </ul>

        {detailImage && (
          <Detail
            image={detailImage}
            originalUrl={api.originalUrl(detailImage.id)}
            saveState={detailSaveState}
            onSetProperty={setDetailProperty}
            onRemoveProperty={removeDetailProperty}
            onClose={() => setDetailImage(null)}
          />
        )}
      </div>
    </div>
  );
}
