import { beforeEach, describe, expect, test } from 'bun:test';
import {
  boardAndSortOf,
  noteOrderVersion,
  orderVersionOf,
  resetOrderVersionsForTest,
  subscribeOrderVersion,
  waitForOrderVersion,
} from '../src/lib/order-version.ts';

beforeEach(resetOrderVersionsForTest);

describe('order versions', () => {
  test('the newest token per board and sort, and a new one is news', () => {
    let heard = 0;
    const stop = subscribeOrderVersion(() => heard++);
    expect(noteOrderVersion('b', 'name.asc', 'A')).toBe(true);
    expect(noteOrderVersion('b', 'name.asc', 'A')).toBe(false);
    expect(noteOrderVersion('b', 'name.asc', 'B')).toBe(true);
    expect(orderVersionOf('b', 'name.asc')).toBe('B');
    expect(orderVersionOf('b', 'uploaded_at.desc')).toBeUndefined();
    expect(heard).toBe(2);
    stop();
  });

  test('a slow answer from an older build never moves the map back', () => {
    noteOrderVersion('b', 's', 'A');
    noteOrderVersion('b', 's', 'B');
    expect(noteOrderVersion('b', 's', 'A')).toBe(false);
    expect(orderVersionOf('b', 's')).toBe('B');
  });

  test('which board and sort a request was about', () => {
    expect(
      boardAndSortOf('/boards/b1/find?sort=name.asc&q=x', undefined),
    ).toEqual({
      boardId: 'b1',
      sort: 'name.asc',
    });
    expect(
      boardAndSortOf('/boards/b1/tiles/name.asc/0/1/2.png?grid=2', undefined),
    ).toEqual({
      boardId: 'b1',
      sort: 'name.asc',
    });
    expect(
      boardAndSortOf(
        '/boards/b1/selection/range',
        JSON.stringify({ sort: 's', fromRank: 0 }),
      ),
    ).toEqual({ boardId: 'b1', sort: 's' });
    expect(boardAndSortOf('/sheets/s1/rows', undefined)).toBeNull();
  });
});

describe('waitForOrderVersion', () => {
  test('answers at once when a token is known, and when a wait already failed', async () => {
    noteOrderVersion('b', 's', 'A');
    expect(await waitForOrderVersion('b', 's', 50)).toBe('A');
    expect(await waitForOrderVersion('b', 'none', 30)).toBeUndefined();
    const started = performance.now();
    expect(await waitForOrderVersion('b', 'none', 1000)).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(50);
  });
  test('a token arriving during the wait ends it', async () => {
    const waiting = waitForOrderVersion('b', 'later', 1000);
    setTimeout(() => noteOrderVersion('b', 'later', 'T'), 10);
    expect(await waiting).toBe('T');
  });
});
