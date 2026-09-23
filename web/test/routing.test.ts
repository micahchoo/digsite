// A connection goes around the pictures between its ends (routing.ts,
// ported from image-graph with its tests, plus the defect found here).
import { describe, expect, test } from 'bun:test';
import {
  LANE,
  type Point,
  distanceToPath,
  midSegment,
  routeOrthogonal,
  simplify,
} from '../src/sheet/routing.ts';

type Rect = { x: number; y: number; width: number; height: number };
const box = (x: number, y: number, width = 100, height = 100): Rect => ({
  x,
  y,
  width,
  height,
});
function enters(path: Point[], r: Rect, lane = LANE): boolean {
  const g = {
    x: r.x - lane,
    y: r.y - lane,
    width: r.width + lane * 2,
    height: r.height + lane * 2,
  };
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1] as Point;
    const b = path[i] as Point;
    const left = Math.min(a.x, b.x);
    const right = Math.max(a.x, b.x);
    const top = Math.min(a.y, b.y);
    const bottom = Math.max(a.y, b.y);
    if (
      left < g.x + g.width &&
      g.x < right &&
      top < g.y + g.height &&
      g.y < bottom
    )
      return true;
  }
  return false;
}
const orthogonal = (path: Point[]) =>
  path.every(
    (p, i) => i === 0 || p.x === path[i - 1]?.x || p.y === path[i - 1]?.y,
  );
const route = (from: Point, to: Point, obstacles: Rect[]) => {
  const path = routeOrthogonal(from, to, obstacles);
  if (!path) throw new Error('no route');
  return path;
};

describe('orthogonal routing', () => {
  test('goes around a picture standing between the two ends', () => {
    const wall = box(200, -50, 100, 200);
    const path = route({ x: 0, y: 50 }, { x: 500, y: 50 }, [wall]);
    expect(orthogonal(path)).toBe(true);
    expect(enters(path, wall)).toBe(false);
    expect(path[0]).toEqual({ x: 0, y: 50 });
    expect(path.at(-1)).toEqual({ x: 500, y: 50 });
    expect(path.length).toBeGreaterThan(2);
  });

  test('prefers fewer corners when two ways round cost the same', () => {
    expect(
      route({ x: 0, y: 0 }, { x: 400, y: 400 }, [box(150, 150)]).length,
    ).toBeLessThanOrEqual(4);
  });

  // Found here: the search was keyed by node alone, so the first arrival at
  // a node claimed it and a way through it with fewer turns was never
  // tried. Around one picture, the line came out with three bends.
  test('around one picture in line with both ends, two bends', () => {
    const path = route({ x: 100, y: 100 }, { x: 700, y: 100 }, [
      box(300, 0, 200, 200),
    ]);
    expect(path).toHaveLength(4);
  });

  test('refuses a detour longer than crossing would be', () => {
    expect(
      routeOrthogonal({ x: 0, y: 0 }, { x: 300, y: 0 }, [
        box(100, -1e6, 100, 2e6),
      ]),
    ).toBeNull();
    expect(
      routeOrthogonal({ x: 0, y: 0 }, { x: 300, y: 0 }, [
        box(100, -150, 100, 300),
      ]),
    ).not.toBeNull();
    expect(routeOrthogonal({ x: 0, y: 0 }, { x: 10, y: 10 }, [])).toBeNull();
  });

  test('keeps only the bends', () => {
    expect(
      simplify([
        { x: 0, y: 0 },
        { x: 5, y: 0 },
        { x: 9, y: 0 },
        { x: 9, y: 4 },
      ]),
    ).toEqual([
      { x: 0, y: 0 },
      { x: 9, y: 0 },
      { x: 9, y: 4 },
    ]);
  });

  test('finds the segment half way along by length, not by count', () => {
    const path = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 100, y: 0 },
      { x: 110, y: 0 },
    ];
    expect(midSegment(path)).toEqual([
      { x: 10, y: 0 },
      { x: 100, y: 0 },
    ]);
  });

  test('measures the pointer against the line drawn, not the chord', () => {
    const wall = box(200, -50, 100, 200);
    const ends: [Point, Point] = [
      { x: 0, y: 50 },
      { x: 500, y: 50 },
    ];
    const path = route(ends[0], ends[1], [wall]);
    const [a, b] = midSegment(path);
    const onTheLine = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    expect(distanceToPath(onTheLine, path)).toBeLessThan(7);
    expect(distanceToPath(onTheLine, ends)).toBeGreaterThan(7);
    expect(distanceToPath({ x: 250, y: 50 }, path)).toBeGreaterThan(7);
  });

  test('takes the nearest segment of a polyline, and its ends are ends', () => {
    const path = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
    ];
    expect(distanceToPath({ x: 50, y: 3 }, path)).toBe(3);
    expect(distanceToPath({ x: 100, y: 140 }, path)).toBe(40);
    expect(distanceToPath({ x: 0, y: 0 }, [{ x: 9, y: 9 }])).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  test('answers a crowded field quickly enough for a frame', () => {
    const obstacles = Array.from({ length: 20 }, (_, i) =>
      box((i % 5) * 220 + 120, Math.floor(i / 5) * 220 + 120, 120, 120),
    );
    const started = performance.now();
    for (let i = 0; i < 30; i++)
      routeOrthogonal({ x: 0, y: i * 7 }, { x: 1300, y: 900 }, obstacles);
    expect((performance.now() - started) / 30).toBeLessThan(6);
  });
});
