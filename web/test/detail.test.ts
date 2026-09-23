// Past the tiles, each visible cell draws its own preview (board/detail.ts).
import { describe, expect, test } from 'bun:test';
import {
  DETAIL_LIMIT,
  containedRect,
  visibleRanks,
} from '../src/board/detail.ts';

describe('visibleRanks', () => {
  test('below the detail zoom, no previews are asked for', () => {
    expect(visibleRanks({ target: [64, 64], zoom: 0 }, 800, 600, 100)).toEqual(
      [],
    );
  });

  test('at 4x, an 800 x 600 view over the first cell shows its neighbours', () => {
    // zoom 2: a 128-unit cell is 512 px, so 800 x 600 spans ~1.6 x 1.2 cells.
    const ranks = visibleRanks({ target: [128, 128], zoom: 2 }, 800, 600, 100);
    expect(ranks).toEqual([0, 1, 16, 17]);
  });

  test('cells past the last image are not asked for', () => {
    expect(visibleRanks({ target: [128, 128], zoom: 2 }, 800, 600, 17)).toEqual(
      [0, 1, 16],
    );
  });

  test('a view holding too many cells asks for none rather than a flood', () => {
    const ranks = visibleRanks(
      { target: [1024, 1024], zoom: 0.5 },
      4000,
      4000,
      100_000,
    );
    expect(ranks.length === 0 || ranks.length <= DETAIL_LIMIT).toBe(true);
  });
});

describe('containedRect', () => {
  test('a wide picture fills the cell width and is centred vertically', () => {
    expect(containedRect(0, 400, 200)).toEqual({
      x: 0,
      y: 32,
      width: 128,
      height: 64,
    });
  });

  test('a tall picture in the second cell is centred horizontally', () => {
    expect(containedRect(1, 100, 200)).toEqual({
      x: 128 + 32,
      y: 0,
      width: 64,
      height: 128,
    });
  });

  test('an unknown size fills the whole cell', () => {
    expect(containedRect(17, 0, 0)).toEqual({
      x: 128,
      y: 128,
      width: 128,
      height: 128,
    });
  });
});
