// What is on screen, and what a point lands on — ported in spirit from
// research/image-graph/src/scene.ts's `GraphScene`: "not *where we are
// looking* — that is the camera" (camera.ts), this is the elements, the
// spatial index over them, and the hit test that measures what the frame
// actually draws (render.ts uses the same rects and the same edge segment —
// ../../../../.claude/rules/image-graph-hit-what-was-drawn.md).
//
// Pure functions over `SceneElement[]` rather than a class holding its own
// copy: the native adapter's source of truth is `index.ts`'s element array,
// and every function here is called against it fresh, the same discipline
// `overlay/screen.ts#foreignShapes` uses for foreign claims (never a cached
// rect — ../../../../.claude/rules/image-graph-foreign-regions.md's web
// cousin, foreign-never-in-scene.md).
import { dataOf, imageGroupId } from '@digsite/shared';
import type { SceneElement } from '../types.ts';
import {
  type Point,
  type Rect,
  distanceToSegment,
  overlaps,
} from './geometry.ts';
import { SpatialIndex } from './spatial.ts';

export type HitKind = 'image' | 'region' | 'edge';
export interface Hit {
  id: string;
  kind: HitKind;
  /** Set for an image or a region hit — the image tools.ts's group ops key on. */
  imageId?: string;
}

/** How near the pointer must land to select a connection, in screen pixels —
 * image-graph's own `REACH`. */
export const EDGE_REACH_PX = 7;
/** How near a grip, in screen pixels. */
export const GRIP_REACH_PX = 6;

function rectOf(el: SceneElement): Rect {
  return { x: el.x, y: el.y, width: el.width, height: el.height };
}

/** Every live (non-deleted) image or region's rect, in array order — the
 * paint order `render.ts` draws them in and the order `SpatialIndex`'s
 * `at()` needs to answer "topmost" correctly. */
export function boxIds(elements: readonly SceneElement[]): {
  ids: string[];
  positions: Map<string, Rect>;
} {
  const ids: string[] = [];
  const positions = new Map<string, Rect>();
  for (const el of elements) {
    if (el.isDeleted) continue;
    const data = dataOf(el);
    if (data?.kind !== 'image' && data?.kind !== 'region') continue;
    ids.push(el.id);
    positions.set(el.id, rectOf(el));
  }
  return { ids, positions };
}

export function buildIndex(elements: readonly SceneElement[]): SpatialIndex {
  const { ids, positions } = boxIds(elements);
  return new SpatialIndex(ids, positions);
}

/** The arrow's own current endpoints, in scene space — dangling.ts's
 * `currentEndpoints`, ported: never recomputed from a bound element here,
 * since this reads exactly what `retargetEdges` last wrote (or what a
 * remote peer sent), which IS the drawn line. */
function edgeEndpoints(el: SceneElement): { start: Point; end: Point } {
  const first = el.points[0] ?? [0, 0];
  const last = el.points[el.points.length - 1] ?? first;
  return {
    start: { x: el.x + first[0], y: el.y + first[1] },
    end: { x: el.x + last[0], y: el.y + last[1] },
  };
}

/**
 * The topmost image or region at `p`, or — failing that — a connection
 * within `EDGE_REACH_PX` (world units, so it shrinks with zoom), or null
 * over empty canvas. Mirrors `../../hit.ts#hitAt` for images/regions
 * (topmost wins) and image-graph's `GraphScene#hit` for the edge fallback
 * (bounding-box reject before the segment distance, so this costs nothing
 * on a frame with no edges near the pointer).
 */
export function hitAt(
  p: Point,
  elements: readonly SceneElement[],
  scale: number,
  index?: SpatialIndex,
): Hit | null {
  const spatial = index ?? buildIndex(elements);
  const byId = new Map(elements.map((e) => [e.id, e] as const));
  for (const id of spatial.at(p)) {
    const el = byId.get(id);
    if (!el) continue;
    const data = dataOf(el);
    if (data?.kind === 'region')
      return { id, kind: 'region', imageId: data.imageId };
    if (data?.kind === 'image')
      return { id, kind: 'image', imageId: data.imageId };
  }

  const reach = EDGE_REACH_PX / scale;
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i];
    if (!el || el.isDeleted) continue;
    if (dataOf(el)?.kind !== 'edge') continue;
    const bx0 = Math.min(el.x, el.x + el.width) - reach;
    const bx1 = Math.max(el.x, el.x + el.width) + reach;
    const by0 = Math.min(el.y, el.y + el.height) - reach;
    const by1 = Math.max(el.y, el.y + el.height) + reach;
    if (p.x < bx0 || p.x > bx1 || p.y < by0 || p.y > by1) continue;
    const { start, end } = edgeEndpoints(el);
    if (distanceToSegment(p, start, end) <= reach)
      return { id: el.id, kind: 'edge' };
  }
  return null;
}

/** Every element a drag on `imageId` carries: the image itself plus every
 * element in its group (regions and their bound labels — `moveImage` in
 * ../../tools.ts is the same rule, ported here for the pointer-driven
 * drag). Edges are not in the group; they follow through `retargetEdges`. */
export function groupMembers(
  elements: readonly SceneElement[],
  imageId: string,
): Set<string> {
  const groupId = imageGroupId(imageId);
  const members = new Set<string>();
  for (const el of elements) {
    if (el.isDeleted) continue;
    const data = dataOf(el);
    const inGroup =
      (data?.kind === 'image' && data.imageId === imageId) ||
      el.groupIds.includes(groupId);
    if (inGroup) members.add(el.id);
  }
  // A region's bound label shares no groupId of its own — it is reached
  // through the region's `boundElements`, not `groupIds`.
  for (const el of elements) {
    if (!members.has(el.id)) continue;
    for (const b of el.boundElements ?? []) members.add(b.id);
  }
  return members;
}

/** Shift every member of `ids` by a scene-space delta. Pure. */
export function shiftElements(
  elements: readonly SceneElement[],
  ids: ReadonlySet<string>,
  dx: number,
  dy: number,
): SceneElement[] {
  if (dx === 0 && dy === 0) return elements.slice();
  return elements.map((el) =>
    ids.has(el.id) ? { ...el, x: el.x + dx, y: el.y + dy } : el,
  );
}

function geometryFor(
  start: Point,
  end: Point,
): Pick<SceneElement, 'x' | 'y' | 'width' | 'height' | 'points'> {
  return {
    x: start.x,
    y: start.y,
    width: Math.abs(end.x - start.x) || 1,
    height: Math.abs(end.y - start.y) || 1,
    points: [
      [0, 0],
      [end.x - start.x, end.y - start.y],
    ],
  };
}

/**
 * "An arrow's points are recomputed from the bound rects on every local
 * change" (docs/phases/2-sheet.md section 8). Bound edges follow their
 * endpoints whenever a bound shape moves; nothing else in this
 * product (`../../scene-diff.ts`) reimplements it, so the native adapter
 * must — every local commit runs every live edge through this before
 * `onChange` fires. An edge whose bound element is gone or deleted is left
 * exactly as it is: `../../scene-diff.ts#reconcileLocalChange`'s cascade
 * (dangling.ts), run at the product layer after `onChange`, is what turns
 * that into a rebind — this function's job is only to follow a LIVE target.
 */
export function retargetEdges(
  elements: readonly SceneElement[],
): SceneElement[] {
  const byId = new Map(elements.map((e) => [e.id, e] as const));
  return elements.map((el) => {
    if (el.isDeleted) return el;
    if (dataOf(el)?.kind !== 'edge') return el;
    if (!el.startBinding || !el.endBinding) return el;
    const source = byId.get(el.startBinding.elementId);
    const target = byId.get(el.endBinding.elementId);
    if (!source || source.isDeleted || !target || target.isDeleted) return el;
    const a = {
      x: source.x + source.width / 2,
      y: source.y + source.height / 2,
    };
    const b = {
      x: target.x + target.width / 2,
      y: target.y + target.height / 2,
    };
    const geom = geometryFor(a, b);
    if (
      el.x === geom.x &&
      el.y === geom.y &&
      el.width === geom.width &&
      el.height === geom.height
    ) {
      return el;
    }
    return { ...el, ...geom };
  });
}

// -- region grips -----------------------------------------------------------

export type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
const GRIPS: Array<[HandleId, number, number]> = [
  ['nw', 0, 0],
  ['n', 0.5, 0],
  ['ne', 1, 0],
  ['e', 1, 0.5],
  ['se', 1, 1],
  ['s', 0.5, 1],
  ['sw', 0, 1],
  ['w', 0, 0.5],
];
const MIN_REGION_SIDE = 4;

/** Grip positions in scene space, fractions of `rect` — image-graph's
 * `regionHandles`, ported from its 0..1-of-the-image convention to ours
 * (a region's own rect is already absolute scene coordinates). */
export function regionHandles(
  rect: Rect,
): { id: HandleId; x: number; y: number }[] {
  return GRIPS.map(([id, fx, fy]) => ({
    id,
    x: rect.x + rect.width * fx,
    y: rect.y + rect.height * fy,
  }));
}

/** The grip at `p`, within `reach` world units, or null. */
export function hitGrip(p: Point, rect: Rect, reach: number): HandleId | null {
  for (const g of regionHandles(rect)) {
    if (Math.hypot(p.x - g.x, p.y - g.y) <= reach) return g.id;
  }
  return null;
}

/** Every image/region id whose rect overlaps `band` (scene space) — the
 * Select tool's marquee, a plain filter rather than a spatial query since a
 * sheet holds at most `SHEET_LIMIT` (150) images plus their regions. */
export function marqueeSelect(
  elements: readonly SceneElement[],
  band: Rect,
): string[] {
  const ids: string[] = [];
  for (const el of elements) {
    if (el.isDeleted) continue;
    const data = dataOf(el);
    if (data?.kind !== 'image' && data?.kind !== 'region') continue;
    if (overlaps(rectOf(el), band)) ids.push(el.id);
  }
  return ids;
}

/** Put one grip at `point` (scene space), keeping the rect legal: never
 * inverted, never smaller than `MIN_REGION_SIDE`. Always applied to the
 * rect as it was when the drag started (`origin`), so a side that hits the
 * minimum and comes back lands where the pointer is — image-graph's
 * `resizeRegion`, ported from its 0..1 fractions to our absolute rect. */
export function resizeRegion(
  origin: Rect,
  handle: HandleId,
  point: Point,
): Rect {
  let left = origin.x;
  let right = origin.x + origin.width;
  let top = origin.y;
  let bottom = origin.y + origin.height;
  if (handle.includes('w')) left = point.x;
  else if (handle.includes('e')) right = point.x;
  if (handle.startsWith('n')) top = point.y;
  else if (handle.startsWith('s')) bottom = point.y;
  const width = Math.max(MIN_REGION_SIDE, Math.abs(right - left));
  const height = Math.max(MIN_REGION_SIDE, Math.abs(bottom - top));
  return { x: Math.min(left, right), y: Math.min(top, bottom), width, height };
}
