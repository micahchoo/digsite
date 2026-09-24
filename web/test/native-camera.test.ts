// The pure arithmetic of the native adapter's camera (canvas/native/camera.ts),
// tested the same way image-graph's own camera.test.ts does —
// research/image-graph/tests/camera.test.ts is the model these mirror,
// rewritten against OUR `Viewport` convention (`screen = (world + scroll) *
// zoom`) instead of image-graph's `screen = world*scale + camera.{x,y}`.
import { describe, expect, test } from 'bun:test';
import {
  MAX_ZOOM,
  MIN_ZOOM,
  fitBox,
  scrollBy,
  toScreen,
  toWorld,
  wheelGesture,
  zoomAt,
  zoomBy,
} from '../src/sheet/canvas/native/camera.ts';
import type { Viewport } from '../src/sheet/canvas/types.ts';

const vp = (scrollX: number, scrollY: number, zoom: number): Viewport => ({
  scrollX,
  scrollY,
  zoom,
});

describe('toWorld / toScreen', () => {
  test('are inverses of one another', () => {
    const v = vp(-40, 120, 1.6);
    const world = toWorld(v, 317, 208);
    const screen = toScreen(v, world);
    expect(screen.x).toBeCloseTo(317, 9);
    expect(screen.y).toBeCloseTo(208, 9);
  });
});

describe('zoomAt', () => {
  test('leaves whatever is under the point exactly where it is', () => {
    const v = vp(-340, 120, 0.8);
    const pointer = { x: 613, y: 91 };
    const before = toWorld(v, pointer.x, pointer.y);
    for (const factor of [1.25, 1 / 1.25, 4, 0.1]) {
      const after = toWorld(zoomAt(v, factor, pointer), pointer.x, pointer.y);
      expect(after.x).toBeCloseTo(before.x, 6);
      expect(after.y).toBeCloseTo(before.y, 6);
    }
  });

  test('stops at the limits rather than drifting past them', () => {
    const pointer = { x: 400, y: 300 };
    expect(zoomAt(vp(0, 0, 1), 1e6, pointer).zoom).toBe(MAX_ZOOM);
    expect(zoomAt(vp(0, 0, 1), 1e-6, pointer).zoom).toBe(MIN_ZOOM);
  });

  test('holds the point still even when it clamps', () => {
    const v = vp(-90, 33, 20);
    const pointer = { x: 210, y: 480 };
    const before = toWorld(v, pointer.x, pointer.y);
    const after = toWorld(zoomAt(v, 100, pointer), pointer.x, pointer.y);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  test('does not mutate the viewport it was given', () => {
    const v = vp(5, 6, 1);
    zoomAt(v, 2, { x: 0, y: 0 });
    expect(v).toEqual({ scrollX: 5, scrollY: 6, zoom: 1 });
  });
});

describe('scrollBy', () => {
  test('moves the view, content following the pointer, and keeps the zoom', () => {
    const moved = scrollBy(vp(10, 20, 2), 30, -6);
    expect(moved.zoom).toBe(2);
    expect(moved.scrollX).toBeCloseTo(10 + 30 / 2, 9);
    expect(moved.scrollY).toBeCloseTo(20 + -6 / 2, 9);
  });
});

describe('fitBox', () => {
  test('centres the box in the container', () => {
    const box = { x: -200, y: -100, width: 400, height: 200 };
    const v = fitBox(box, 800, 600, vp(0, 0, 1));
    const centre = toScreen(v, { x: 0, y: 0 });
    expect(centre.x).toBeCloseTo(400, 6);
    expect(centre.y).toBeCloseTo(300, 6);
  });

  test('shows the whole box, with the padding to spare', () => {
    const box = { x: 40, y: 900, width: 3000, height: 1500 };
    const v = fitBox(box, 800, 600, vp(0, 0, 1));
    const topLeft = toScreen(v, { x: box.x, y: box.y });
    const bottomRight = toScreen(v, {
      x: box.x + box.width,
      y: box.y + box.height,
    });
    expect(topLeft.x).toBeGreaterThanOrEqual(-0.01);
    expect(topLeft.y).toBeGreaterThanOrEqual(-0.01);
    expect(bottomRight.x).toBeLessThanOrEqual(800.01);
    expect(bottomRight.y).toBeLessThanOrEqual(600.01);
  });

  test('returns the viewport unchanged for a container with no room', () => {
    const current = vp(3, 4, 2);
    expect(fitBox({ x: 0, y: 0, width: 10, height: 10 }, 0, 600, current)).toBe(
      current,
    );
  });
});

describe('zoomBy', () => {
  test('zooms about the given anchor', () => {
    const v = vp(0, 0, 1);
    const anchor = { x: 400, y: 300 };
    const beforeWorld = toWorld(v, anchor.x, anchor.y);
    const after = zoomBy(v, 2, anchor.x, anchor.y);
    expect(after.zoom).toBeCloseTo(2, 9);
    const afterWorld = toWorld(after, anchor.x, anchor.y);
    expect(afterWorld.x).toBeCloseTo(beforeWorld.x, 6);
    expect(afterWorld.y).toBeCloseTo(beforeWorld.y, 6);
  });
});

describe('wheelGesture', () => {
  test('a mouse wheel zooms, as on the board; a trackpad slide pans', () => {
    expect(wheelGesture({ deltaX: 0, deltaY: -100 }, 600)).toMatchObject({
      kind: 'zoom',
      into: true,
    });
    expect(wheelGesture({ deltaX: 3, deltaY: 9 }, 600)).toEqual({
      kind: 'scroll',
      dx: 3,
      dy: 9,
    });
    expect(
      wheelGesture({ deltaX: 0, deltaY: -10, ctrlKey: true }, 600).kind,
    ).toBe('zoom');
    expect(
      wheelGesture({ deltaX: 0, deltaY: -10, metaKey: true }, 600).kind,
    ).toBe('zoom');
  });

  test('zooms in when the wheel goes up and out when it goes down', () => {
    const into = wheelGesture({ deltaX: 0, deltaY: -10, ctrlKey: true }, 600);
    const outOf = wheelGesture({ deltaX: 0, deltaY: 10, ctrlKey: true }, 600);
    expect(into).toMatchObject({ kind: 'zoom', into: true });
    expect(outOf).toMatchObject({ kind: 'zoom', into: false });
    if (into.kind === 'zoom' && outOf.kind === 'zoom') {
      expect(into.factor).toBeGreaterThan(1);
      expect(outOf.factor).toBeLessThan(1);
    }
  });

  test('normalises lines and pages, because Firefox does not report pixels', () => {
    const lines = wheelGesture(
      { deltaX: 0, deltaY: 3, deltaMode: 1, shiftKey: true },
      600,
    );
    expect(lines).toEqual({ kind: 'scroll', dx: 48, dy: 0 });
    const pages = wheelGesture({ deltaX: 0, deltaY: 1, deltaMode: 2 }, 600);
    expect(pages).toMatchObject({ kind: 'zoom', factor: Math.exp(-0.9) });
  });

  test('pans a one-axis wheel sideways under shift, and leaves a trackpad alone', () => {
    expect(
      wheelGesture({ deltaX: 0, deltaY: 20, shiftKey: true }, 600),
    ).toEqual({
      kind: 'scroll',
      dx: 20,
      dy: 0,
    });
    expect(
      wheelGesture({ deltaX: 7, deltaY: 20, shiftKey: true }, 600),
    ).toEqual({
      kind: 'scroll',
      dx: 7,
      dy: 20,
    });
  });
});
