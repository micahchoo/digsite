// One zoom for two pictures of different sizes (components/compare-view.ts).
import { describe, expect, test } from 'bun:test';
import {
  START,
  WHOLE,
  panBy,
  placement,
  zoomAt,
} from '../src/components/compare-view.ts';

const pane = { width: 400, height: 300 };
const wide = { width: 1600, height: 900, focus: WHOLE };
const small = { width: 200, height: 200, focus: WHOLE };

describe('placement', () => {
  test('at the start each picture is fitted and centred in its pane', () => {
    expect(placement(wide, pane, START)).toEqual({
      left: 0,
      top: 37.5,
      width: 400,
      height: 225,
    });
    expect(placement(small, pane, START)).toEqual({
      left: 50,
      top: 0,
      width: 300,
      height: 300,
    });
  });

  test('a region focus fills the pane with that region', () => {
    const region = { ...wide, focus: { fx: 0.5, fy: 0.5, fw: 0.25, fh: 0.25 } };
    // The region is 400 x 225 px; fitted at 1:1 and centred.
    const p = placement(region, pane, START);
    expect(p.width).toBeCloseTo(1600);
    expect(p.left).toBeCloseTo(200 - 1000);
    expect(p.top).toBeCloseTo(150 - 0.625 * 900);
  });
});

describe('one view, two pictures', () => {
  test('zooming at a point keeps that point still on the side it is over', () => {
    const at = { x: 100, y: 60 };
    const before = placement(wide, pane, START);
    const view = zoomAt(START, 2, at, wide, pane);
    const after = placement(wide, pane, view);
    // The picture pixel under the pointer is the same before and after.
    const pxBefore = (at.x - before.left) / before.width;
    const pxAfter = (at.x - after.left) / after.width;
    expect(pxAfter).toBeCloseTo(pxBefore);
    expect(view.zoom).toBe(2);
  });

  test('the same view puts the same relative point of each picture at the pane centre', () => {
    const view = { zoom: 3, px: 0.25, py: -0.25 };
    for (const side of [wide, small]) {
      const p = placement(side, pane, view);
      // The pane centre shows 75% across and 25% down of either picture.
      expect((pane.width / 2 - p.left) / p.width).toBeCloseTo(0.75);
      expect((pane.height / 2 - p.top) / p.height).toBeCloseTo(0.25);
    }
  });

  test('a drag moves the picture with the pointer', () => {
    const before = placement(wide, pane, START);
    const after = placement(wide, pane, panBy(START, 30, -10, wide, pane));
    expect(after.left - before.left).toBeCloseTo(30);
    expect(after.top - before.top).toBeCloseTo(-10);
  });
});
