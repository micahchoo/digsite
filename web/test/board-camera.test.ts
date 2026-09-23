// Where the board's map looks (board/camera.ts): fits, centring and zoom,
// as the page's controls, menus and walks ask for them.
import { describe, expect, test } from 'bun:test';
import {
  MAX_TILE_ZOOM,
  MAX_ZOOM,
  MIN_ZOOM,
  centreOn,
  fitBoard,
  fitRanks,
  zoomTo,
} from '../src/board/camera.ts';

const screen = { width: 1024, height: 768 };

describe('fitBoard', () => {
  test('a small board opens centred on its own images', () => {
    const cam = fitBoard(4, screen);
    // four cells in one row: 512 units wide, 128 high
    expect(cam.target).toEqual([256, 64, 0]);
    expect(cam.zoom).toBe(MAX_TILE_ZOOM);
  });

  test('an opening fit keeps a cell legible; fit everything does not', () => {
    // 400 full rows: 2,048 x 51,200 units. The height alone would fit at
    // 2^-6; the floor holds a cell at 64 px, which is also the full width.
    const big = 16 * 400;
    expect(fitBoard(big, screen).zoom).toBe(-1);
    expect(fitBoard(big, screen, true).zoom).toBe(MIN_ZOOM);
  });

  test('never past the tiles, never below the pyramid', () => {
    expect(fitBoard(1, { width: 10000, height: 10000 }).zoom).toBe(
      MAX_TILE_ZOOM,
    );
    expect(fitBoard(16 * 100000, screen, true).zoom).toBe(MIN_ZOOM);
  });
});

describe('centreOn', () => {
  test("looks at the centre of the rank's cell and keeps the zoom", () => {
    const cam = centreOn(fitBoard(100, screen), 17);
    expect(cam.target).toEqual([128 + 64, 128 + 64, 0]);
    expect(cam.zoom).toBe(fitBoard(100, screen).zoom);
  });
});

describe('zoomTo', () => {
  test('holds the zoom inside the view limits', () => {
    const cam = fitBoard(100, screen);
    expect(zoomTo(cam, 99).zoom).toBe(MAX_ZOOM);
    expect(zoomTo(cam, -99).zoom).toBe(MIN_ZOOM);
    expect(zoomTo(cam, 1).target).toEqual(cam.target);
  });
});

describe('fitRanks', () => {
  test('nothing to fit is no move', () => {
    expect(fitRanks(fitBoard(100, screen), [], screen)).toBeNull();
  });

  test('centres on the cells and leaves a cell of margin', () => {
    // ranks 0 and 17: cols 0..1, rows 0..1, a 256 x 256 box
    const cam = fitRanks(fitBoard(100, screen), [17, 0], screen);
    expect(cam?.target).toEqual([128, 128, 0]);
    // the box plus a cell of margin (384 units) fills the short side
    expect(cam?.zoom).toBeCloseTo(Math.log2(768 / 384));
  });
});
