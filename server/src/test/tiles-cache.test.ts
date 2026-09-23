import { describe, expect, test } from 'bun:test';
// Roadmap C2: a tile composed from the old order must not be cached after
// the invalidation for the new order has already emptied the cache.
import {
  composedGeneration,
  getComposedTile,
  invalidateAllComposedTiles,
  invalidateComposedTiles,
  setComposedTile,
} from '../boards/tiles-cache.ts';

describe('composed-tile cache generations', () => {
  test('a tile whose compose spanned an invalidation is not stored', () => {
    const boardId = crypto.randomUUID();
    const url = `/boards/${boardId}/tiles/name.asc/0/0/0.png`;
    const since = composedGeneration(boardId); // compose starts: old order
    invalidateComposedTiles(boardId); // a rebuild lands meanwhile
    expect(setComposedTile(url, boardId, Buffer.from('old'), since)).toBe(
      false,
    );
    expect(getComposedTile(url)).toBeUndefined();
  });

  test('a clear-all after a reconnect counts too', () => {
    const boardId = crypto.randomUUID();
    const url = `/boards/${boardId}/tiles/name.asc/0/0/1.png`;
    const since = composedGeneration(boardId);
    invalidateAllComposedTiles();
    expect(setComposedTile(url, boardId, Buffer.from('old'), since)).toBe(
      false,
    );
  });

  test('another board moving on does not block this one', () => {
    const boardId = crypto.randomUUID();
    const url = `/boards/${boardId}/tiles/name.asc/0/0/2.png`;
    const since = composedGeneration(boardId);
    invalidateComposedTiles(crypto.randomUUID());
    expect(setComposedTile(url, boardId, Buffer.from('new'), since)).toBe(true);
    expect(getComposedTile(url)?.toString()).toBe('new');
  });
});
