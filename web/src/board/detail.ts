// Close enough to read a picture. The tile pyramid stops at z = 0, where a
// cell is 128 px: that is the resolution a ladder page stores, and a map
// for finding things does not need more. Studying a picture does. Past
// z = 0 the view keeps zooming, tiles are stretched, and this layer draws
// each visible cell's own preview (the original, at most 1024 px) on top,
// contained in the cell exactly as the ladder contains it
// (server/src/boards/ladder.ts: `fit: 'contain'`, centred).
//
// Only what is on screen is fetched, and at z >= 0.5 that is a few dozen
// cells at most. image-graph does the same: its atlas at low zoom, a
// detail cache once the owner zooms in (`thumbnails.ts`).
import { CELL, COLS, cellOf } from '@digsite/shared/board/grid';

/** The view may zoom this far past the tiles: a cell becomes 1024 px, the
 * largest a preview is stored at. */
export const MAX_VIEW_ZOOM = 3;
/** From this zoom on, a stretched tile is visibly soft, so previews draw. */
export const DETAIL_FROM_ZOOM = 0.5;
/** Never ask for more than this many previews at once. */
export const DETAIL_LIMIT = 64;

interface View {
  target: readonly number[];
  zoom: number;
}

/** The ranks whose cells the view shows, row by row, or none below
 * `DETAIL_FROM_ZOOM` or past `DETAIL_LIMIT` cells. */
export function visibleRanks(
  view: View,
  width: number,
  height: number,
  count: number,
): number[] {
  if (view.zoom < DETAIL_FROM_ZOOM || count <= 0) return [];
  const scale = 2 ** view.zoom;
  const [cx = 0, cy = 0] = view.target;
  const x0 = cx - width / 2 / scale;
  const x1 = cx + width / 2 / scale;
  const y0 = cy - height / 2 / scale;
  const y1 = cy + height / 2 / scale;
  const col0 = Math.max(0, Math.floor(x0 / CELL));
  const col1 = Math.min(COLS - 1, Math.floor(x1 / CELL));
  const row0 = Math.max(0, Math.floor(y0 / CELL));
  const row1 = Math.min(Math.ceil(count / COLS) - 1, Math.floor(y1 / CELL));
  const out: number[] = [];
  for (let row = row0; row <= row1; row++)
    for (let col = col0; col <= col1; col++) {
      const rank = row * COLS + col;
      if (rank < count) out.push(rank);
    }
  return out.length <= DETAIL_LIMIT ? out : [];
}

/** Where a picture of `width` x `height` sits in the cell of `rank`:
 * contained and centred, as the ladder draws it. */
export function containedRect(
  rank: number,
  width: number,
  height: number,
): { x: number; y: number; width: number; height: number } {
  const { col, row } = cellOf(rank);
  const fit = Math.min(CELL / (width || 1), CELL / (height || 1));
  const w = width && height ? width * fit : CELL;
  const h = width && height ? height * fit : CELL;
  return {
    x: col * CELL + (CELL - w) / 2,
    y: row * CELL + (CELL - h) / 2,
    width: w,
    height: h,
  };
}

/**
 * Decoded previews by image id, least recently used out first. A bitmap
 * holds its decoded pixels outside the JS heap, so an evicted one is
 * closed, never left to the collector.
 */
/**
 * Each visible picture's preview bitmap, loaded once and kept for the
 * last `limit` asked for. Asking (`want`) and reading are apart: the page
 * holds `onChanged`'s snapshot as state and draws from it, so a bitmap that
 * arrives is a change the page can see, never a signal hidden in a ref.
 */
export class DetailCache {
  private readonly bitmaps = new Map<string, ImageBitmap>();
  private readonly pending = new Set<string>();
  private readonly failed = new Set<string>();

  constructor(
    private readonly load: (id: string) => Promise<ImageBitmap>,
    /** Every bitmap held, after one arrived or was let go. */
    private readonly onChanged: (
      held: ReadonlyMap<string, ImageBitmap>,
    ) => void,
    private readonly limit = DETAIL_LIMIT * 2,
  ) {}

  /** Asks for a picture's bitmap: kept as the most recent when it is held,
   * loaded once when it is not. */
  want(id: string): void {
    const held = this.bitmaps.get(id);
    if (held) {
      this.bitmaps.delete(id);
      this.bitmaps.set(id, held);
      return;
    }
    if (this.pending.has(id) || this.failed.has(id)) return;
    this.pending.add(id);
    this.load(id)
      .then((bitmap) => {
        this.bitmaps.set(id, bitmap);
        const gone: ImageBitmap[] = [];
        while (this.bitmaps.size > this.limit) {
          const [oldest, old] = this.bitmaps.entries().next().value ?? [];
          if (!oldest || !old) break;
          this.bitmaps.delete(oldest);
          gone.push(old);
        }
        // The page stops drawing a bitmap before it is closed.
        this.onChanged(new Map(this.bitmaps));
        for (const old of gone) old.close();
      })
      .catch(() => this.failed.add(id))
      .finally(() => this.pending.delete(id));
  }

  clear(): void {
    const all = [...this.bitmaps.values()];
    this.bitmaps.clear();
    this.failed.clear();
    this.onChanged(new Map());
    for (const bitmap of all) bitmap.close();
  }
}
