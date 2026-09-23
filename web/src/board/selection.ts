// Pure: shift-drag selects a rank range. A rank is already row-major
// (CONTEXT.md "Rank"), so "start to end by row-major order" is just the
// ascending integer span between the two ends, however the drag ran.
// Capped at SHEET_LIMIT — the same cap a sheet enforces on its images
// (shared/src/sheet/elements.ts) — since a selection's purpose is "New sheet".
import { CELL, SHEET_LIMIT, cellOf } from '@digsite/shared';

export interface RankRangeResult {
  ranks: number[];
  truncated: boolean;
}

export function rankRange(
  a: number,
  b: number,
  limit: number = SHEET_LIMIT,
): RankRangeResult {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const truncated = hi - lo + 1 > limit;
  const end = truncated ? lo + limit - 1 : hi;
  const ranks: number[] = [];
  for (let r = lo; r <= end; r++) ranks.push(r);
  return { ranks, truncated };
}

export function toggleRank(selected: Set<number>, rank: number): Set<number> {
  const next = new Set(selected);
  if (next.has(rank)) next.delete(rank);
  else next.add(rank);
  return next;
}

export function addRanks(selected: Set<number>, ranks: number[]): Set<number> {
  const next = new Set(selected);
  for (const r of ranks) next.add(r);
  return next;
}

/** The world-space square a rank's cell occupies, for the selection outline
 * PolygonLayer — a closed ring, top-left origin, CELL units on a side. */
export function cellPolygon(rank: number): [number, number][] {
  const { col, row } = cellOf(rank);
  const x = col * CELL;
  const y = row * CELL;
  return [
    [x, y],
    [x + CELL, y],
    [x + CELL, y + CELL],
    [x, y + CELL],
  ];
}

/** A small triangle in a cell's top-right corner, world space: the mark on
 * an image some sheet has annotated (CONTEXT.md "Making sense"). */
export function cellCorner(rank: number, size: number): [number, number][] {
  const { col, row } = cellOf(rank);
  const right = (col + 1) * CELL;
  const top = row * CELL;
  return [
    [right - size, top],
    [right, top],
    [right, top + size],
  ];
}
