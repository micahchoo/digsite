import { describe, expect, test } from 'bun:test';
import {
  CELL,
  COLS,
  cellOf,
  rankAtWorld,
  rankOf,
  tileRanks,
  worldExtent,
} from '../src/board/grid.ts';

describe('cellOf / rankOf', () => {
  test('round-trip for a spread of ranks', () => {
    for (const rank of [0, 1, 1023, 1024, 1025, 500_000, 999_999]) {
      const { col, row } = cellOf(rank);
      expect(rankOf(col, row)).toBe(rank);
    }
  });
});

describe('tileRanks', () => {
  test('z=0 tile (0,0)', () => {
    expect(tileRanks(0, 0, 0)).toEqual([0, 1, 16, 17]);
  });

  test('z=-5 has length 4096', () => {
    expect(tileRanks(-5, 0, 0).length).toBe(4096);
  });

  test('a tile past COLS is all -1', () => {
    expect(tileRanks(0, COLS / 2, 0)).toEqual([-1, -1, -1, -1]);
    expect(tileRanks(0, -1, 0)).toEqual([-1, -1, -1, -1]);
  });
});

describe('rankAtWorld', () => {
  test('outside the grid never wraps onto a different row', () => {
    expect(rankAtWorld(COLS * CELL, 0)).toBe(-1);
    expect(rankAtWorld(-1, CELL)).toBe(-1);
    expect(rankAtWorld(0, -1)).toBe(-1);
  });
  test('inverse of the cell rect for a spread of ranks', () => {
    for (const rank of [0, 1, 1024, 500_000]) {
      const { col, row } = cellOf(rank);
      const x = col * CELL + CELL / 2;
      const y = row * CELL + CELL / 2;
      expect(rankAtWorld(x, y)).toBe(rank);
    }
  });
});

describe('worldExtent', () => {
  test('1 image', () => {
    expect(worldExtent(1)).toEqual([0, 0, 2048, 128]);
  });
  test('16 images (one full row)', () => {
    expect(worldExtent(16)).toEqual([0, 0, 2048, 128]);
  });
  test('17 images (spills to a second row)', () => {
    expect(worldExtent(17)).toEqual([0, 0, 2048, 256]);
  });
  test('61 images form four compact rows without moving earlier ranks', () => {
    expect(worldExtent(61)).toEqual([0, 0, 2048, 512]);
    expect(cellOf(60)).toEqual({ col: 12, row: 3 });
  });
});
