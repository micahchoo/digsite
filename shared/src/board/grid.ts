// The map: a rank (position under one sort) lands in a fixed row-major
// grid, then a tile pyramid samples that grid at coarser zooms. Compact
// rows keep ordinary collections readable. Column count stays fixed while
// images arrive: imports never reflow the existing layout. Ranks are still
// distinct from ladder slots. Version both browser and stored tile caches
// when changing this geometry.

export const COLS = 16;
export const GRID_LAYOUT_VERSION = 2;
export const CELL = 128;
export const TILE = 256;

export const ZOOMS = [0, -1, -2, -3, -4, -5] as const;
export type Zoom = (typeof ZOOMS)[number];

export function cellOf(rank: number): { col: number; row: number } {
  return { col: rank % COLS, row: Math.floor(rank / COLS) };
}

export function rankOf(col: number, row: number): number {
  return row * COLS + col;
}

/** Screen pixels a 128-world-unit cell occupies at zoom z: 128 * 2^z. */
export function cellPx(z: Zoom): number {
  return CELL * 2 ** z;
}

/** Cells per tile side: a 256px tile divided into cellPx(z)-sized cells. */
export function perTileSide(z: Zoom): number {
  return TILE / cellPx(z);
}

/**
 * The ranks covered by tile (z, x, y), row-major. `tileRanks` does not know
 * the board's image count, so a rank past the end is still returned — the
 * caller decides what an empty cell looks like. A column past COLS has no
 * rank at all (the grid is COLS wide however tall it grows) and is -1.
 */
export function tileRanks(z: Zoom, x: number, y: number): number[] {
  const n = perTileSide(z);
  const out: number[] = [];
  for (let rho = 0; rho < n; rho++) {
    const row = y * n + rho;
    for (let kappa = 0; kappa < n; kappa++) {
      const col = x * n + kappa;
      out.push(col < 0 || col >= COLS || row < 0 ? -1 : rankOf(col, row));
    }
  }
  return out;
}

/** The world-space square a tile covers: side = perTileSide(z) * CELL. */
export function tileWorld(
  z: Zoom,
  x: number,
  y: number,
): { x: number; y: number; size: number } {
  const size = perTileSide(z) * CELL;
  return { x: x * size, y: y * size, size };
}

/** The world rectangle [0, 0, w, h] a board of `count` images fills. */
export function worldExtent(count: number): [number, number, number, number] {
  const rows = Math.max(1, Math.ceil(count / COLS));
  return [0, 0, COLS * CELL, rows * CELL];
}

/** The rank whose cell rectangle contains world point (wx, wy). */
export function rankAtWorld(wx: number, wy: number): number {
  const col = Math.floor(wx / CELL);
  const row = Math.floor(wy / CELL);
  if (
    !Number.isFinite(col) ||
    !Number.isFinite(row) ||
    col < 0 ||
    col >= COLS ||
    row < 0
  )
    return -1;
  return rankOf(col, row);
}
