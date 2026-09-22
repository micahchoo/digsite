import { TILE, type Zoom } from '@digsite/shared/board/grid';
import { ladderAddress, sizeFor } from '@digsite/shared/board/ladder';
import type { Sort } from '@digsite/shared/board/sort';
// Composing one tile (CONTEXT.md "Tile"): a 256px PNG of the cells in one
// square of the map at one zoom, from the ladder pages, cached. See
// .claude/rules/ladder-slot-vs-rank.md and
// .claude/rules/tile-cache-is-for-the-second-viewer.md.
import { createCanvas } from '@napi-rs/canvas';
import { getPage } from './ladder.ts';
import { slotsForTile } from './ranks.ts';
import { getComposedTile, setComposedTile } from './tiles-cache.ts';

export async function composeTile(
  boardId: string,
  cellPx: number,
  slots: (number | null)[],
): Promise<Buffer> {
  const n = Math.round(Math.sqrt(slots.length));
  const s = sizeFor(cellPx);
  const canvas = createCanvas(TILE, TILE);
  const ctx = canvas.getContext('2d');

  for (let idx = 0; idx < slots.length; idx++) {
    const slot = slots[idx];
    if (slot === null || slot === undefined) continue;
    const row = Math.floor(idx / n);
    const col = idx % n;
    const { page, x, y } = ladderAddress(slot, s);
    const pageCanvas = await getPage(boardId, s, page);
    ctx.drawImage(
      pageCanvas,
      x,
      y,
      s,
      s,
      col * cellPx,
      row * cellPx,
      cellPx,
      cellPx,
    );
  }

  return canvas.encodeSync('png');
}

export type TileResult = {
  png: Buffer;
  cache: 'hit' | 'miss';
  rankMs: number;
  composeMs: number;
};

/** Composes (or returns cached) the PNG for one tile. `cacheKey` is the
 * request URL, per the composed-tile cache's contract. */
export async function tileFor(
  boardId: string,
  sort: Sort,
  z: Zoom,
  x: number,
  y: number,
  cellPx: number,
  cacheKey: string,
): Promise<TileResult> {
  const cached = getComposedTile(cacheKey);
  if (cached) return { png: cached, cache: 'hit', rankMs: 0, composeMs: 0 };

  const rankStart = performance.now();
  const slots = await slotsForTile(boardId, sort, z, x, y);
  const rankMs = performance.now() - rankStart;

  const composeStart = performance.now();
  const png = await composeTile(boardId, cellPx, slots);
  const composeMs = performance.now() - composeStart;

  setComposedTile(cacheKey, boardId, png);
  return { png, cache: 'miss', rankMs, composeMs };
}
