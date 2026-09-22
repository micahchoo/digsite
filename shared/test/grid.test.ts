import { describe, expect, test } from 'bun:test';
import {
  CELL,
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
    expect(tileRanks(0, 0, 0)).toEqual([0, 1, 1024, 1025]);
  });

  test('z=-5 has length 4096', () => {
    expect(tileRanks(-5, 0, 0).length).toBe(4096);
  });

  test('a tile past COLS is all -1', () => {
    // z=0 → n=2 cells/side; x=512 puts every column at 1024 or 1025, both ≥ COLS.
    expect(tileRanks(0, 512, 0)).toEqual([-1, -1, -1, -1]);
  });
});

describe('rankAtWorld', () => {
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
    expect(worldExtent(1)).toEqual([0, 0, 131072, 128]);
  });
  test('1024 images (one full row)', () => {
    expect(worldExtent(1024)).toEqual([0, 0, 131072, 128]);
  });
  test('1025 images (spills to a second row)', () => {
    expect(worldExtent(1025)).toEqual([0, 0, 131072, 256]);
  });
});
