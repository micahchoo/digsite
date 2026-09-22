// Pure tests, no server, no DOM — see ../src/board/explore-layout.ts.
// Checked directly against server/src/sheets/routes.ts's own arithmetic
// (`Math.min(FIT / w, FIT / h, 1)`, `x = centre.x - w / 2`) rather than
// re-deriving it, per docs/phases/2-sheet.md section 4.
import { describe, expect, test } from 'bun:test';
import { centreToTopLeft, fitScale } from '../src/board/explore-layout.ts';

describe('fitScale', () => {
  test('scales a large image down to fit', () => {
    expect(fitScale(512, 256)).toBeCloseTo(256 / 512);
  });

  test('never upscales a small image', () => {
    expect(fitScale(100, 50)).toBe(1);
  });

  test('the limiting dimension is whichever needs the smaller scale', () => {
    // 256/512 = 0.5, 256/128 = 2 -> the width is limiting.
    expect(fitScale(512, 128)).toBeCloseTo(0.5);
  });
});

describe('centreToTopLeft', () => {
  test('subtracts half the fit-scaled width/height from the centre', () => {
    const placed = centreToTopLeft({ x: 100, y: 200 }, 512, 256);
    const scale = fitScale(512, 256);
    expect(placed.width).toBeCloseTo(512 * scale);
    expect(placed.height).toBeCloseTo(256 * scale);
    expect(placed.x).toBeCloseTo(100 - placed.width / 2);
    expect(placed.y).toBeCloseTo(200 - placed.height / 2);
  });

  test('matches the unscaled case exactly (routes.ts with scale=1)', () => {
    const placed = centreToTopLeft({ x: 0, y: 0 }, 100, 50);
    expect(placed).toEqual({ x: -50, y: -25, width: 100, height: 50 });
  });

  test('a centre at the origin places the box symmetrically around it', () => {
    const placed = centreToTopLeft({ x: 0, y: 0 }, 200, 200);
    expect(placed.x).toBeCloseTo(-placed.width / 2);
    expect(placed.y).toBeCloseTo(-placed.height / 2);
  });
});
