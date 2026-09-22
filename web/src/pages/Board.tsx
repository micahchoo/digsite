// The map: deck.gl OrthographicView + TileLayer over the server's tile
// pyramid (docs/design.md "web/", `/b/:id`). Imperative deck.gl, matching
// ../../../prototype/board/viewer/src/main.ts's pattern — the tile-index ->
// URL mapping was verified there against deck.gl's tileset-2d source and is
// reused unchanged: deck's {x,y,z} is the server's {z}/{x}/{y} verbatim.
import {
  Deck,
  OrthographicView,
  type OrthographicViewState,
} from '@deck.gl/core';
import { TileLayer } from '@deck.gl/geo-layers';
import { BitmapLayer } from '@deck.gl/layers';
import {
  type BoardImage,
  CELL,
  COLS,
  DEFAULT_SORT,
  type GetBoardResponse,
  type Sort,
  type SortKey,
  parseSortId,
  rankAtWorld,
  sortId,
  worldExtent,
} from '@digsite/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { api } from '../lib/api.ts';

declare global {
  interface Window {
    __digsiteBoard?: { setZoom: (z: number) => void };
  }
}

const MIN_ZOOM = -5;
const MAX_ZOOM = 0;
const TILE_SIZE = 256;

interface Status {
  zoom: number;
  tilesRequested: number;
  cacheHits: number;
  cacheTotal: number;
  ttftMs: number | null;
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

  const [board, setBoard] = useState<GetBoardResponse | null>(null);
  const [sort, setSort] = useState<Sort>(DEFAULT_SORT);
  const [generation, setGeneration] = useState(0);
  const [selection, setSelection] = useState<BoardImage[]>([]);
  const [clickInfo, setClickInfo] = useState<string>('');
  const [sheetName, setSheetName] = useState('');
  const [, forceRender] = useState(0);

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
      onClick: (info) => {
        if (!info.coordinate) return;
        const [wx, wy] = info.coordinate as [number, number];
        void handleClick(wx, wy);
      },
    });
    return () => {
      deckRef.current?.finalize();
      deckRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board]);

  // A debug-only hook for the smoke script's screenshots — NOT part of the
  // fixed window.__digsite contract (that is sheet-only, see sheet/tools.ts).
  // It sets zoom deterministically instead of guessing a wheel gesture.
  useEffect(() => {
    window.__digsiteBoard = {
      setZoom: (z: number) => {
        if (!deckRef.current || !viewStateRef.current) return;
        viewStateRef.current = { ...viewStateRef.current, zoom: z };
        deckRef.current.setProps({ viewState: viewStateRef.current });
        statusRef.current.zoom = z;
        forceRender((n) => n + 1);
      },
    };
  }, []);

  // -- rebuild the tile layer on sort or upload -------------------------------
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

  useEffect(() => {
    if (!deckRef.current || !board) return;
    sortChangeAt.current = performance.now();
    statusRef.current = {
      ...statusRef.current,
      tilesRequested: 0,
      cacheHits: 0,
      cacheTotal: 0,
      ttftMs: null,
    };
    const [, , w, h] = worldExtent(board.imageCount);
    const layer = new TileLayer({
      id: `board-tiles-${currentSortId}-${generation}`,
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
    deckRef.current.setProps({ layers: [layer] });
    forceRender((n) => n + 1);
  }, [board, currentSortId, generation, fetchTile]);

  async function handleClick(wx: number, wy: number) {
    if (!board) return;
    const rank = rankAtWorld(wx, wy);
    if (rank < 0 || rank >= board.imageCount) {
      setClickInfo(`rank ${rank} — empty`);
      return;
    }
    const { images } = await api.listBoardImages(
      boardId,
      currentSortId,
      rank,
      1,
    );
    const image = images[0];
    if (!image) {
      setClickInfo(`rank ${rank} — no image`);
      return;
    }
    setClickInfo(`rank ${rank} — ${image.name}`);
    setSelection((prev) => {
      const exists = prev.some((i) => i.id === image.id);
      return exists ? prev.filter((i) => i.id !== image.id) : [...prev, image];
    });
  }

  async function upload(files: FileList | null) {
    if (!files || !files.length || !board) return;
    await api.uploadImages(boardId, Array.from(files));
    const fresh = await api.getBoard(boardId);
    setBoard(fresh);
    setGeneration((n) => n + 1);
  }

  async function createSheetFromSelection(e: React.FormEvent) {
    e.preventDefault();
    if (!sheetName.trim() || !selection.length) return;
    const { id: newId } = await api.createSheet(boardId, {
      name: sheetName.trim(),
      imageIds: selection.map((i) => i.id),
    });
    navigate(`/s/${newId}`);
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
              type="file"
              multiple
              onChange={(e) => void upload(e.target.files)}
            />
          </label>
        </div>
        {clickInfo && (
          <div className="status-line" style={{ bottom: 40 }}>
            {clickInfo}
          </div>
        )}
      </div>
      <div
        style={{
          width: 280,
          borderLeft: '1px solid #ddd',
          overflow: 'auto',
          padding: 8,
        }}
      >
        <h3>{board.name}</h3>
        <div className="muted">{board.imageCount} images</div>
        <h4>selection ({selection.length})</h4>
        <ul>
          {selection.map((i) => (
            <li key={i.id}>{i.name}</li>
          ))}
        </ul>
        <form onSubmit={(e) => void createSheetFromSelection(e)}>
          <input
            data-testid="sheet-name"
            placeholder="new sheet name"
            value={sheetName}
            onChange={(e) => setSheetName(e.target.value)}
          />
          <button type="submit" disabled={!selection.length}>
            new sheet
          </button>
        </form>
      </div>
    </div>
  );
}
