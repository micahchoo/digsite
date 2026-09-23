// What a connection is drawn along. A line that runs across an unrelated
// picture reads as passing behind it, so a connection goes around the
// pictures between its ends on an orthogonal path, and is trimmed out of
// the two things it joins. Ported from image-graph's `routing.ts` and
// `GraphScene#route`.
//
// Three readers must agree about the path: the canvas draws it
// (`canvas/native/render.ts`), the hit test measures it
// (`canvas/native/scene.ts#hitAt`), and the overlay puts the relation label
// on it (`overlay/Overlay.tsx`). All three ask `edgePaths`, so none can
// draw one line and answer for another. Other sheets' connections take the
// same way round through `foreignPaths`
// (../../../.claude/rules/image-graph-hit-what-was-drawn.md in the notebook).
import { clipPath, dataOf } from '@digsite/shared';

export interface Point {
  x: number;
  y: number;
}
interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface Boxed extends Rect {
  id: string;
  isDeleted?: boolean;
  customData?: unknown;
  startBinding?: { elementId: string } | null;
  endBinding?: { elementId: string } | null;
  points?: readonly (readonly [number, number])[];
}

/** Above this many connections, routing costs more than the tangle it removes. */
export const ROUTE_LIMIT = 240;
/** Below this zoom nothing a line would route around is legible. */
export const ROUTE_MIN_SCALE = 0.06;
/** Room left between a path and a picture, in scene units. */
export const LANE = 26;
/** Extra cost of one corner, so a route with fewer corners wins over a
 * marginally shorter one. */
const TURN = 90;
const MAX_OBSTACLES = 20;
/** A detour longer than this multiple of the direct distance reads worse
 * than crossing the picture. The caller then draws a straight line. */
const MAX_DETOUR = 2.4;

const inside = (r: Rect, x: number, y: number) =>
  x > r.x && x < r.x + r.width && y > r.y && y < r.y + r.height;

/** Does the axis-aligned segment enter any obstacle? Touching a border does
 * not count. */
function blocked(
  obstacles: readonly Rect[],
  ax: number,
  ay: number,
  bx: number,
  by: number,
): boolean {
  const left = Math.min(ax, bx);
  const right = Math.max(ax, bx);
  const top = Math.min(ay, by);
  const bottom = Math.max(ay, by);
  for (const r of obstacles)
    if (
      left < r.x + r.width &&
      r.x < right &&
      top < r.y + r.height &&
      r.y < bottom
    )
      return true;
  return false;
}

/** Smallest-first queue over node indexes. */
class Heap {
  private readonly items: number[] = [];
  private readonly keys: number[] = [];
  get size(): number {
    return this.items.length;
  }
  push(item: number, key: number): void {
    this.items.push(item);
    this.keys.push(key);
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.key(parent) <= this.key(i)) break;
      this.swap(parent, i);
      i = parent;
    }
  }
  pop(): number {
    const top = this.items[0] ?? -1;
    const lastItem = this.items.pop();
    const lastKey = this.keys.pop();
    if (this.items.length && lastItem !== undefined && lastKey !== undefined) {
      this.items[0] = lastItem;
      this.keys[0] = lastKey;
      for (let i = 0; ; ) {
        const left = i * 2 + 1;
        const right = left + 1;
        let small = i;
        if (left < this.items.length && this.key(left) < this.key(small))
          small = left;
        if (right < this.items.length && this.key(right) < this.key(small))
          small = right;
        if (small === i) break;
        this.swap(small, i);
        i = small;
      }
    }
    return top;
  }
  private key(i: number): number {
    return this.keys[i] ?? Number.POSITIVE_INFINITY;
  }
  private swap(a: number, b: number): void {
    const item = this.items[a] as number;
    this.items[a] = this.items[b] as number;
    this.items[b] = item;
    const key = this.keys[a] as number;
    this.keys[a] = this.keys[b] as number;
    this.keys[b] = key;
  }
}

const axis = (values: number[]) => [...new Set(values)].sort((a, b) => a - b);

/**
 * An orthogonal path from `from` to `to` that enters no obstacle, or null
 * when none exists or it is too long a way round. Obstacles must already
 * exclude what the connection joins.
 *
 * The grid is every obstacle edge, so a path that exists at all exists on
 * it, and it has a few hundred nodes rather than a pixel lattice. A* walks
 * it with a penalty per turn.
 */
export function routeOrthogonal(
  from: Point,
  to: Point,
  obstacles: readonly Rect[],
  lane = LANE,
  maxDetour = MAX_DETOUR,
): Point[] | null {
  if (!obstacles.length) return null;
  const near = obstacles.slice(0, MAX_OBSTACLES).map((r) => ({
    x: r.x - lane,
    y: r.y - lane,
    width: r.width + lane * 2,
    height: r.height + lane * 2,
  }));
  const xs = axis([from.x, to.x, ...near.flatMap((r) => [r.x, r.x + r.width])]);
  const ys = axis([
    from.y,
    to.y,
    ...near.flatMap((r) => [r.y, r.y + r.height]),
  ]);
  const columns = xs.length;
  const nodes = columns * ys.length;
  const X = (node: number) => xs[node % columns] as number;
  const Y = (node: number) => ys[(node / columns) | 0] as number;
  const open = new Uint8Array(nodes);
  for (let node = 0; node < nodes; node++)
    open[node] = near.some((r) => inside(r, X(node), Y(node))) ? 0 : 1;
  const start = ys.indexOf(from.y) * columns + xs.indexOf(from.x);
  const goal = ys.indexOf(to.y) * columns + xs.indexOf(to.x);
  if (!open[start] || !open[goal]) return null;

  // A search state is a node AND the axis it was reached along, so a turn
  // is charged against the way the path actually came in. Keyed by node
  // alone, the first arrival claims the node and a cheaper-in-turns way
  // through it is never tried: A to B around one picture came out with
  // three bends where two do.
  const states = nodes * 2;
  const best = new Float64Array(states).fill(Number.POSITIVE_INFINITY);
  const cameFrom = new Int32Array(states).fill(-1);
  const guess = (node: number) =>
    Math.abs(X(node) - to.x) + Math.abs(Y(node) - to.y);
  const queue = new Heap();
  for (const axisBit of [0, 1]) {
    best[start * 2 + axisBit] = 0;
    queue.push(start * 2 + axisBit, guess(start));
  }
  const steps: [number, number][] = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  let reached = -1;
  while (queue.size) {
    const state = queue.pop();
    const node = state >> 1;
    if (node === goal) {
      reached = state;
      break;
    }
    const i = node % columns;
    const j = (node / columns) | 0;
    const cameVertical = (state & 1) === 1;
    for (const [di, dj] of steps) {
      const ni = i + di;
      const nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= columns || nj >= ys.length) continue;
      const next = nj * columns + ni;
      if (!open[next] || blocked(near, X(node), Y(node), X(next), Y(next)))
        continue;
      const vertical = di === 0;
      const turned = node !== start && vertical !== cameVertical;
      const cost =
        (best[state] as number) +
        Math.abs(X(next) - X(node)) +
        Math.abs(Y(next) - Y(node)) +
        (turned ? TURN : 0);
      const nextState = next * 2 + (vertical ? 1 : 0);
      if (cost >= (best[nextState] as number)) continue;
      best[nextState] = cost;
      cameFrom[nextState] = state;
      queue.push(nextState, cost + guess(next));
    }
  }
  if (reached < 0) return null;
  const path: Point[] = [];
  for (let state = reached; state >= 0; state = cameFrom[state] ?? -1)
    path.push({ x: X(state >> 1), y: Y(state >> 1) });
  path.reverse();
  // Measured on the path, not the search cost: that carries the turn
  // penalty, which breaks ties and says nothing about distance travelled.
  const direct = Math.abs(to.x - from.x) + Math.abs(to.y - from.y);
  let travelled = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1] as Point;
    const b = path[i] as Point;
    travelled += Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
  }
  if (travelled > Math.max(direct, lane * 4) * maxDetour) return null;
  return simplify(path);
}

/** Drop the middle of any three points on one line; only bends matter. */
export function simplify(path: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (const point of path) {
    const last = out[out.length - 1];
    const before = out[out.length - 2];
    if (last && last.x === point.x && last.y === point.y) continue;
    if (
      before &&
      last &&
      ((before.x === last.x && last.x === point.x) ||
        (before.y === last.y && last.y === point.y))
    )
      out.pop();
    out.push(point);
  }
  return out;
}

/** The segment holding the point half way along by length — where a
 * label goes. */
export function midSegment(path: readonly Point[]): [Point, Point] {
  const first = path[0] ?? { x: 0, y: 0 };
  const last = path[path.length - 1] ?? first;
  let total = 0;
  for (let i = 1; i < path.length; i++)
    total += dist(path[i - 1] as Point, path[i] as Point);
  let walked = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1] as Point;
    const b = path[i] as Point;
    const length = dist(a, b);
    if (walked + length >= total / 2) return [a, b];
    walked += length;
  }
  return [first, last];
}

const dist = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);

function toSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = Math.max(
    0,
    Math.min(
      1,
      ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1),
    ),
  );
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

/** How far a point lies from a polyline. The hit test measures this, the
 * line the frame drew, never the chord between the ends. */
export function distanceToPath(p: Point, path: readonly Point[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 1; i < path.length; i++)
    best = Math.min(best, toSegment(p, path[i - 1] as Point, path[i] as Point));
  return best;
}

// -- every connection on a sheet ------------------------------------------

const rectOf = (el: Rect): Rect => ({
  x: el.x,
  y: el.y,
  width: el.width,
  height: el.height,
});
const centre = (r: Rect): Point => ({
  x: r.x + r.width / 2,
  y: r.y + r.height / 2,
});
const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height;

/** The arrow's own stored ends, in scene space: what `retargetEdges` last
 * wrote, or what a peer sent. Used when an end is not bound to anything
 * live. */
function storedEnds(el: Boxed): [Point, Point] {
  const first = el.points?.[0] ?? [0, 0];
  const last = el.points?.[el.points.length - 1] ?? first;
  return [
    { x: el.x + first[0], y: el.y + first[1] },
    { x: el.x + last[0], y: el.y + last[1] },
  ];
}

/** Whether a frame at this zoom with this many connections routes at all.
 * One expression, so the canvas, the hit test and the labels cannot
 * disagree about it. */
export function routes(scale: number, edgeCount: number): boolean {
  return scale > ROUTE_MIN_SCALE && edgeCount <= ROUTE_LIMIT;
}

/**
 * The way from one rectangle's centre to another's around every picture in
 * between, or null when the two touch, nothing is in the way, or no way
 * round is short enough. `hosts` are the pictures the two ends belong to:
 * a connection never goes around its own. Unclipped; the caller trims it
 * out of its ends.
 */
function routeAround(
  fromRect: Rect,
  toRect: Rect,
  hosts: readonly (string | null)[],
  images: readonly { imageId: string; rect: Rect }[],
): Point[] | null {
  if (overlaps(fromRect, toRect)) return null;
  const start = centre(fromRect);
  const end = centre(toRect);
  const ends = new Set(hosts);
  const span = {
    x: Math.min(start.x, end.x) - LANE * 2,
    y: Math.min(start.y, end.y) - LANE * 2,
    width: Math.abs(start.x - end.x) + LANE * 4,
    height: Math.abs(start.y - end.y) + LANE * 4,
  };
  const obstacles = images
    .filter((i) => !ends.has(i.imageId) && overlaps(i.rect, span))
    .map((i) => i.rect);
  return obstacles.length ? routeOrthogonal(start, end, obstacles) : null;
}

const cache = new WeakMap<readonly Boxed[], Map<string, Point[]>>();
const straightCache = new WeakMap<readonly Boxed[], Map<string, Point[]>>();

/**
 * Every live connection's drawn path, scene space, keyed by element id: at
 * least two points, trimmed out of the image or region at each end, around
 * the pictures between them when `routes(scale, …)` says so.
 *
 * Cached per elements array, so a pan or a zoom computes nothing and a
 * change to the scene, which makes a new array, computes it all once.
 */
export function edgePaths<T extends Boxed>(
  elements: readonly T[],
  scale: number,
): ReadonlyMap<string, Point[]> {
  let edgeCount = 0;
  for (const el of elements)
    if (!el.isDeleted && dataOf(el)?.kind === 'edge') edgeCount++;
  const routed = routes(scale, edgeCount);
  const store = routed ? cache : straightCache;
  const held = store.get(elements);
  if (held) return held;

  const byId = new Map<string, T>();
  const images: { id: string; imageId: string; rect: Rect }[] = [];
  for (const el of elements) {
    if (el.isDeleted) continue;
    byId.set(el.id, el);
    const data = dataOf(el);
    if (data?.kind === 'image')
      images.push({ id: el.id, imageId: data.imageId, rect: rectOf(el) });
  }
  const live = (id: string | undefined) => (id ? byId.get(id) : undefined);
  const hostOf = (el: T | undefined) => {
    const data = el ? dataOf(el) : null;
    return data?.kind === 'image' || data?.kind === 'region'
      ? data.imageId
      : null;
  };

  const out = new Map<string, Point[]>();
  for (const el of elements) {
    if (el.isDeleted || dataOf(el)?.kind !== 'edge') continue;
    const from = live(el.startBinding?.elementId);
    const to = live(el.endBinding?.elementId);
    const [a, b] = storedEnds(el);
    const fromRect = from ? rectOf(from) : null;
    const toRect = to ? rectOf(to) : null;
    const around =
      routed && fromRect && toRect
        ? routeAround(fromRect, toRect, [hostOf(from), hostOf(to)], images)
        : null;
    out.set(el.id, clipPath(around ?? [a, b], fromRect, toRect));
  }
  store.set(elements, out);
  return out;
}

/** A connection another sheet made, as the overlay has it: its two ends'
 * rectangles on this sheet and the pictures they belong to. */
export interface ForeignLine {
  id: string;
  from: Rect;
  to: Rect;
  hosts: readonly [string, string];
}

const foreignCache = new WeakMap<
  readonly ForeignLine[],
  { elements: readonly Boxed[]; routed: boolean; out: Map<string, Point[]> }
>();

/**
 * Other sheets' connections, drawn by the same rule as this sheet's own:
 * around the pictures between their ends when `routes` says so, trimmed out
 * of both ends. Keyed by the foreign shape's id; cached per lines and scene.
 */
export function foreignPaths(
  lines: readonly ForeignLine[],
  elements: readonly Boxed[],
  scale: number,
): ReadonlyMap<string, Point[]> {
  const routed = routes(scale, lines.length);
  const held = foreignCache.get(lines);
  if (held && held.elements === elements && held.routed === routed)
    return held.out;
  const images: { imageId: string; rect: Rect }[] = [];
  if (routed)
    for (const el of elements) {
      if (el.isDeleted) continue;
      const data = dataOf(el);
      if (data?.kind === 'image')
        images.push({ imageId: data.imageId, rect: rectOf(el) });
    }
  const out = new Map<string, Point[]>();
  for (const line of lines) {
    const around = routed
      ? routeAround(line.from, line.to, line.hosts, images)
      : null;
    out.set(
      line.id,
      clipPath(
        around ?? [centre(line.from), centre(line.to)],
        line.from,
        line.to,
      ),
    );
  }
  foreignCache.set(lines, { elements, routed, out });
  return out;
}
