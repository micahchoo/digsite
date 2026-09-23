// Pure: shift-drag's rank range (order, cap) and the selection set ops.
// No DOM, no deck.gl — see ../src/board/selection.ts.
import { describe, expect, test } from 'bun:test';
import { SHEET_LIMIT } from '@digsite/shared';
import {
  addRanks,
  cellCorner,
  cellPolygon,
  rankRange,
  toggleRank,
} from '../src/board/selection.ts';

describe('rankRange', () => {
  test('ascending order regardless of which end the drag started on', () => {
    expect(rankRange(10, 3).ranks).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
    expect(rankRange(3, 10).ranks).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
  });

  test('a single rank (no real drag) is a range of one', () => {
    expect(rankRange(5, 5)).toEqual({ ranks: [5], truncated: false });
  });

  test('caps at SHEET_LIMIT by default, keeping the low end and flagging it', () => {
    const { ranks, truncated } = rankRange(0, 1000);
    expect(truncated).toBe(true);
    expect(ranks).toHaveLength(SHEET_LIMIT);
    expect(ranks[0]).toBe(0);
    expect(ranks.at(-1)).toBe(SHEET_LIMIT - 1);
  });

  test('a span at exactly the limit is not truncated', () => {
    const { ranks, truncated } = rankRange(0, SHEET_LIMIT - 1);
    expect(truncated).toBe(false);
    expect(ranks).toHaveLength(SHEET_LIMIT);
  });

  test('a caller-supplied limit overrides SHEET_LIMIT', () => {
    const { ranks, truncated } = rankRange(0, 10, 3);
    expect(truncated).toBe(true);
    expect(ranks).toEqual([0, 1, 2]);
  });
});

describe('toggleRank', () => {
  test('adds an absent rank, removes a present one, and does not mutate the input', () => {
    const empty = new Set<number>();
    const added = toggleRank(empty, 4);
    expect(added.has(4)).toBe(true);
    expect(empty.has(4)).toBe(false);
    const removed = toggleRank(added, 4);
    expect(removed.has(4)).toBe(false);
  });
});

describe('addRanks', () => {
  test('unions without duplicating and without mutating the input', () => {
    const start = new Set([1, 2]);
    const next = addRanks(start, [2, 3, 4]);
    expect([...next].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    expect([...start].sort((a, b) => a - b)).toEqual([1, 2]);
  });
});

describe('cellPolygon', () => {
  test('a 128-unit square at rank 0', () => {
    expect(cellPolygon(0)).toEqual([
      [0, 0],
      [128, 0],
      [128, 128],
      [0, 128],
    ]);
  });

  test('a rank in row 2 is offset by row * CELL', () => {
    const points = cellPolygon(16 * 2 + 3);
    expect(points[0]).toEqual([3 * 128, 2 * 128]);
  });
});

describe('cellCorner', () => {
  test("a triangle in the top-right corner of the rank's cell", () => {
    // rank 17 is col 1, row 1: the cell spans x 128..256, y 128..256.
    expect(cellCorner(17, 20)).toEqual([
      [236, 128],
      [256, 128],
      [256, 148],
    ]);
  });
});
