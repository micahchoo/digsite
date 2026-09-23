import { describe, expect, test } from 'bun:test';
import { clipBetween, clipPath } from '../src/sheet/segment.ts';

const a = { x: 0, y: 0, width: 200, height: 200 };
const b = { x: 600, y: 0, width: 200, height: 200 };

describe('clipBetween', () => {
  test('a centre-to-centre line keeps only the part between the two borders', () => {
    expect(clipBetween({ x: 100, y: 100 }, { x: 700, y: 100 }, a, b)).toEqual({
      start: { x: 200, y: 100 },
      end: { x: 600, y: 100 },
    });
  });

  test('a diagonal leaves through the nearer side', () => {
    const { start } = clipBetween(
      { x: 100, y: 100 },
      { x: 700, y: 400 },
      a,
      null,
    );
    expect(start).toEqual({ x: 200, y: 150 });
  });

  test('overlapping ends keep the whole line rather than a reversed sliver', () => {
    const overlap = { x: 50, y: 0, width: 200, height: 200 };
    const line = clipBetween(
      { x: 100, y: 100 },
      { x: 150, y: 100 },
      a,
      overlap,
    );
    expect(line).toEqual({
      start: { x: 100, y: 100 },
      end: { x: 150, y: 100 },
    });
  });
});

describe('clipPath', () => {
  test('a routed path loses the part inside each end, bends kept', () => {
    // Centre of a, up over an obstacle, down to the centre of b.
    const path = [
      { x: 100, y: 100 },
      { x: 100, y: -100 },
      { x: 700, y: -100 },
      { x: 700, y: 100 },
    ];
    expect(clipPath(path, a, b)).toEqual([
      { x: 100, y: 0 },
      { x: 100, y: -100 },
      { x: 700, y: -100 },
      { x: 700, y: 0 },
    ]);
  });

  test('two points behave exactly as clipBetween', () => {
    expect(
      clipPath(
        [
          { x: 100, y: 100 },
          { x: 700, y: 100 },
        ],
        a,
        b,
      ),
    ).toEqual([
      { x: 200, y: 100 },
      { x: 600, y: 100 },
    ]);
  });
});
