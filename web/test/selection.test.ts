// Pure: what a press on the map does to the selection, and the shapes
// the selection is drawn with. No DOM, no deck.gl — see
// ../src/board/selection.ts.
import { describe, expect, test } from 'bun:test';
import {
  type Press,
  cellCorner,
  cellPolygon,
  pressMove,
} from '../src/board/selection.ts';

/** Cell images by rank; counts the lookups a press made. */
function cells(ids: Record<number, string>) {
  const asked: number[] = [];
  return {
    asked,
    imageAt: async (rank: number) => {
      asked.push(rank);
      return ids[rank] ?? null;
    },
  };
}

const plain = (rank: number): Press => ({ rank, toggle: false, extend: false });

describe('pressMove', () => {
  test('a plain press selects only that image and anchors there', async () => {
    const c = cells({ 4: 'a' });
    expect(await pressMove(plain(4), null, ['x', 'y'], c.imageAt)).toEqual({
      kind: 'only',
      id: 'a',
      anchor: 4,
    });
  });

  test('a plain press on the only selected image clears it', async () => {
    const c = cells({ 4: 'a' });
    expect(await pressMove(plain(4), 9, ['a'], c.imageAt)).toEqual({
      kind: 'clear',
      anchor: 4,
    });
  });

  test('Ctrl/Cmd toggles, even the only selected image', async () => {
    const c = cells({ 4: 'a' });
    const press = { rank: 4, toggle: true, extend: false };
    expect(await pressMove(press, null, ['a'], c.imageAt)).toEqual({
      kind: 'toggle',
      id: 'a',
      anchor: 4,
    });
  });

  test('Shift extends from the anchor without looking the image up', async () => {
    const c = cells({ 12: 'a' });
    const press = { rank: 12, toggle: false, extend: true };
    expect(await pressMove(press, 3, [], c.imageAt)).toEqual({
      kind: 'range',
      from: 3,
      to: 12,
      anchor: 12,
    });
    expect(c.asked).toEqual([]);
  });

  test('Shift with no anchor yet is a plain press', async () => {
    const c = cells({ 12: 'a' });
    const press = { rank: 12, toggle: false, extend: true };
    expect((await pressMove(press, null, [], c.imageAt)).kind).toBe('only');
  });

  test('a cell whose image cannot be read moves nothing, not the anchor', async () => {
    const c = cells({});
    expect(await pressMove(plain(4), 7, ['a'], c.imageAt)).toEqual({
      kind: 'none',
      anchor: 7,
    });
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
