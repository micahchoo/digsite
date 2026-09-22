import { describe, expect, test } from 'bun:test';
import {
  MIN_FRACTION,
  clampFraction,
  fromFraction,
  toFraction,
} from '../src/sheet/fractions.ts';

describe('toFraction / fromFraction round-trip', () => {
  test('a region inside an image', () => {
    const image = { x: 100, y: 200, width: 400, height: 300 };
    const region = { x: 140, y: 260, width: 100, height: 60 };
    const f = toFraction(region, image);
    expect(fromFraction(f, image)).toEqual(region);
  });
});

describe('clampFraction', () => {
  test('pins fx + fw <= 1', () => {
    const f = clampFraction({ fx: 0.9, fy: 0, fw: 0.5, fh: 0.2 });
    expect(f.fx + f.fw).toBeLessThanOrEqual(1);
  });

  test('pins fy + fh <= 1', () => {
    const f = clampFraction({ fx: 0, fy: 0.9, fw: 0.2, fh: 0.5 });
    expect(f.fy + f.fh).toBeLessThanOrEqual(1);
  });

  test('enforces MIN_FRACTION on a zero-size fraction', () => {
    const f = clampFraction({ fx: 0.5, fy: 0.5, fw: 0, fh: 0 });
    expect(f.fw).toBeGreaterThanOrEqual(MIN_FRACTION);
    expect(f.fh).toBeGreaterThanOrEqual(MIN_FRACTION);
  });

  test('leaves an in-range fraction untouched', () => {
    const f = { fx: 0.1, fy: 0.2, fw: 0.3, fh: 0.4 };
    expect(clampFraction(f)).toEqual(f);
  });
});
