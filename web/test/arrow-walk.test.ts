import { describe, expect, test } from 'bun:test';
import { nextInDirection } from '../src/sheet/arrow-walk.ts';

// A 3 x 2 grid of 100-px pictures, 50 apart:  a b c / d e f
const at = (id: string, col: number, row: number) => ({
  id,
  x: col * 150,
  y: row * 150,
  width: 100,
  height: 100,
});
const grid = [
  at('a', 0, 0),
  at('b', 1, 0),
  at('c', 2, 0),
  at('d', 0, 1),
  at('e', 1, 1),
  at('f', 2, 1),
];

describe('nextInDirection', () => {
  test('straight neighbours on a grid', () => {
    expect(nextInDirection(grid, 'e', 'left')).toBe('d');
    expect(nextInDirection(grid, 'e', 'right')).toBe('f');
    expect(nextInDirection(grid, 'e', 'up')).toBe('b');
    expect(nextInDirection(grid, 'b', 'down')).toBe('e');
  });
  test('the edge of the sheet goes nowhere', () => {
    expect(nextInDirection(grid, 'a', 'left')).toBeNull();
    expect(nextInDirection(grid, 'a', 'up')).toBeNull();
  });
  test('straight ahead beats a nearer diagonal', () => {
    const boxes = [
      { id: 'o', x: 0, y: 0, width: 10, height: 10 },
      { id: 'diag', x: 60, y: 50, width: 10, height: 10 },
      { id: 'straight', x: 120, y: 0, width: 10, height: 10 },
    ];
    expect(nextInDirection(boxes, 'o', 'right')).toBe('straight');
  });
});
