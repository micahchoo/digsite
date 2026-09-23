import { describe, expect, test } from 'bun:test';
import { besideSpot } from '../src/sheet/beside.ts';

const parent = { x: 0, y: 0, width: 200, height: 200 };
const size = { width: 100, height: 100 };

describe('besideSpot', () => {
  test('to the right, centred, when the right is free', () => {
    expect(besideSpot(parent, size, [parent])).toEqual({ x: 248, y: 50 });
  });
  test('below when the right is taken, then left, then above', () => {
    const right = { x: 260, y: 0, width: 200, height: 200 };
    expect(besideSpot(parent, size, [parent, right])).toEqual({
      x: 50,
      y: 248,
    });
    const below = { x: 0, y: 260, width: 200, height: 200 };
    expect(besideSpot(parent, size, [parent, right, below])).toEqual({
      x: -148,
      y: 50,
    });
  });
  // Found in the claims walk: handed the element itself, its own x and y
  // replaced the spot being tried, so every side read as free.
  test('a size that carries its own position is measured at the spot', () => {
    const right = { x: 292, y: 0, width: 200, height: 200 };
    const element = { x: 900, y: 900, width: 70, height: 70 };
    expect(besideSpot(parent, element, [parent, right])).toEqual({
      x: 65,
      y: 248,
    });
  });
  test('nowhere free, no answer', () => {
    const all = [
      parent,
      { x: 230, y: -100, width: 300, height: 400 },
      { x: -100, y: 230, width: 400, height: 300 },
      { x: -330, y: -100, width: 300, height: 400 },
      { x: -100, y: -330, width: 400, height: 300 },
    ];
    expect(besideSpot(parent, size, all)).toBeNull();
  });
});
