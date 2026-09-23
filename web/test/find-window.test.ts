import { describe, expect, test } from 'bun:test';
import { CELL, COLS } from '@digsite/shared';
import { WINDOW_MAX, rankWindow } from '../src/board/find.ts';

// A view whose middle is row `row`, at zoom 0: one world unit per pixel.
const at = (row: number, zoom = 0) => ({
  target: [COLS * CELL * 0.5, row * CELL],
  zoom,
});

describe('the ranks on screen, for a find that dims them all', () => {
  test('the rows in view and a screen more each way, snapped to blocks', () => {
    const w = rankWindow(at(100), 900, 1_000_000);
    expect(w).not.toBeNull();
    if (!w) return;
    expect(w.from % 1024).toBe(0);
    expect((w.to + 1) % 1024).toBe(0);
    // The screen's own rows are inside.
    expect(w.from).toBeLessThanOrEqual(
      100 * COLS - Math.ceil(450 / CELL) * COLS,
    );
    expect(w.to).toBeGreaterThanOrEqual(
      100 * COLS + Math.ceil(450 / CELL) * COLS,
    );
  });

  test('a small pan asks nothing new', () => {
    expect(rankWindow(at(100), 900, 1_000_000)).toEqual(
      rankWindow(at(101), 900, 1_000_000),
    );
  });

  test('zoomed far out, the window stays under the cap, around the middle', () => {
    const w = rankWindow(at(30_000, -5), 900, 1_000_000);
    if (!w) throw new Error('no window');
    expect(w.to - w.from + 1).toBeLessThanOrEqual(WINDOW_MAX);
    expect(w.from).toBeLessThanOrEqual(30_000 * COLS);
    expect(w.to).toBeGreaterThanOrEqual(30_000 * COLS);
  });

  test('never past the last image, and nothing for an empty board', () => {
    expect(rankWindow(at(2), 900, 40)?.to).toBe(39);
    expect(rankWindow(at(2), 900, 0)).toBeNull();
  });
});
