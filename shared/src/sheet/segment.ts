// A connection is drawn from the border of what it joins to the border of
// the other end, never across its own ends. Both drawing paths use this:
// the canvas for a sheet's own edges and the overlay for other sheets'
// edges. A line that covered its own ends took the clicks meant for the
// pictures under it, on either path.
import type { Rect } from './fractions.ts';

type Point = { x: number; y: number };

function contains(r: Rect, p: Point): boolean {
  return (
    p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height
  );
}

/** Where the segment from `from` (inside `r`) toward `to` crosses r's border. */
function exitPoint(r: Rect, from: Point, to: Point): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const tx =
    dx > 0 ? (r.x + r.width - from.x) / dx : dx < 0 ? (r.x - from.x) / dx : 1;
  const ty =
    dy > 0 ? (r.y + r.height - from.y) / dy : dy < 0 ? (r.y - from.y) / dy : 1;
  const t = Math.max(0, Math.min(1, tx, ty));
  return { x: from.x + dx * t, y: from.y + dy * t };
}

/** The drawn part of `start -> end`, clipped out of the rects at its ends.
 * Ends so close that their rects overlap would clip into a reversed sliver,
 * so the whole segment is kept then. */
export function clipBetween(
  start: Point,
  end: Point,
  fromRect: Rect | null,
  toRect: Rect | null,
): { start: Point; end: Point } {
  const s =
    fromRect && contains(fromRect, start)
      ? exitPoint(fromRect, start, end)
      : start;
  const e =
    toRect && contains(toRect, end) ? exitPoint(toRect, end, start) : end;
  const forward =
    (e.x - s.x) * (end.x - start.x) + (e.y - s.y) * (end.y - start.y);
  return forward > 0 ? { start: s, end: e } : { start, end };
}

/** A polyline trimmed out of the rects at its ends: the leading points
 * inside `fromRect` and the trailing points inside `toRect` are replaced by
 * the point where the path crosses the border. A two-point path is
 * `clipBetween`, overlap fallback included. */
export function clipPath(
  path: readonly Point[],
  fromRect: Rect | null,
  toRect: Rect | null,
): Point[] {
  const first = path[0];
  const last = path[path.length - 1];
  if (!first || !last) return [];
  if (path.length === 2) {
    const { start, end } = clipBetween(first, last, fromRect, toRect);
    return [start, end];
  }
  const head = trimStart(path, fromRect);
  return trimStart([...head].reverse(), toRect).reverse();
}

function trimStart(path: readonly Point[], r: Rect | null): Point[] {
  const first = path[0];
  if (!r || !first || !contains(r, first)) return [...path];
  for (let i = 1; i < path.length; i++) {
    const point = path[i] as Point;
    if (!contains(r, point))
      return [exitPoint(r, path[i - 1] as Point, point), ...path.slice(i)];
  }
  return [...path];
}
