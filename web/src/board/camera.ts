// Where the board's map is looking, and every way the page moves it. The
// map is a deck.gl OrthographicView: `target` is the world point at the
// centre of the canvas, and one world unit is 2^zoom screen pixels, so a
// cell is `128 * 2^zoom` px (shared/src/board/grid.ts).
//
// Every function here is pure and returns a new camera, as
// sheet/canvas/native/camera.ts does for the sheet. The page keeps one
// camera and writes it in one place (Board.tsx#setView). Before this
// module each move wrote the ref, deck and the zoom readout itself, eleven
// times, and centred on a cell with its own copy of the arithmetic.
import { CELL, COLS, cellOf, worldExtent } from '@digsite/shared/board/grid';
import { MAX_VIEW_ZOOM } from './detail.ts';

export const MIN_ZOOM = -5;
/** The tile pyramid's finest level: a cell is 128 px, as a ladder page
 * stores it. The view zooms past it (MAX_ZOOM) and board/detail.ts draws
 * each visible cell's own preview there. */
export const MAX_TILE_ZOOM = 0;
export const MAX_ZOOM = MAX_VIEW_ZOOM;

/** The smallest cell a first fit shows: half native size, legible. */
const MIN_FIT_CELL_PX = 64;

/** deck.gl's OrthographicViewState, narrowed to what the board sets. */
export type BoardCamera = {
  target: [number, number, number];
  zoom: number;
  minZoom: number;
  maxZoom: number;
};

/** The canvas's size in CSS pixels. */
export type Screen = { width: number; height: number };

const clamp = (value: number, low: number, high: number) =>
  Math.max(low, Math.min(high, value));

/**
 * The whole board, centred. Fits the used ranks rather than the full row
 * width, so a small collection opens centred on its images.
 *
 * docs/ux/audit.md #15: the tightest fit of a board whose one row is wider
 * than the canvas shrinks that row's height by the same factor, down to a
 * sliver. So an opening fit keeps a cell at least MIN_FIT_CELL_PX, but
 * never wider than the board's own canvas. A floor derived from the
 * canvas height instead was tried: it forces full zoom on any board with
 * few rows. `everything` drops the floor: the owner asked to see it all.
 */
export function fitBoard(
  count: number,
  screen: Screen,
  everything = false,
): BoardCamera {
  const [, , , worldH] = worldExtent(count);
  const contentW = Math.min(Math.max(count, 1), COLS) * CELL;
  const zoomX = Math.log2(screen.width / contentW);
  const zoomY = Math.log2(screen.height / worldH);
  let zoom = Math.min(zoomX, zoomY);
  const floor = Math.min(Math.log2(MIN_FIT_CELL_PX / CELL), zoomX);
  if (!everything) zoom = Math.max(zoom, floor);
  // A fit shows the map, so it stops where the tiles do.
  zoom = clamp(zoom, MIN_ZOOM, MAX_TILE_ZOOM);
  return {
    target: [contentW / 2, worldH / 2, 0],
    zoom,
    minZoom: MIN_ZOOM,
    maxZoom: MAX_ZOOM,
  };
}

/** The same zoom, looking at the centre of `rank`'s cell. */
export function centreOn(camera: BoardCamera, rank: number): BoardCamera {
  const { col, row } = cellOf(rank);
  return {
    ...camera,
    target: [col * CELL + CELL / 2, row * CELL + CELL / 2, 0],
  };
}

/** The same place at another zoom, held inside the view's limits. */
export function zoomTo(camera: BoardCamera, zoom: number): BoardCamera {
  return { ...camera, zoom: clamp(zoom, MIN_ZOOM, MAX_ZOOM) };
}

/** Every cell of `ranks` on screen, with a cell's margin around them; null
 * when there are none. */
export function fitRanks(
  camera: BoardCamera,
  ranks: readonly number[],
  screen: Screen,
): BoardCamera | null {
  if (ranks.length === 0) return null;
  const cells = ranks.map((r) => cellOf(r));
  const x0 = Math.min(...cells.map((c) => c.col)) * CELL;
  const x1 = (Math.max(...cells.map((c) => c.col)) + 1) * CELL;
  const y0 = Math.min(...cells.map((c) => c.row)) * CELL;
  const y1 = (Math.max(...cells.map((c) => c.row)) + 1) * CELL;
  const w = Math.max(x1 - x0, CELL);
  const h = Math.max(y1 - y0, CELL);
  return zoomTo(
    { ...camera, target: [(x0 + x1) / 2, (y0 + y1) / 2, 0] },
    Math.min(
      Math.log2(screen.width / (w + CELL)),
      Math.log2(screen.height / (h + CELL)),
    ),
  );
}
