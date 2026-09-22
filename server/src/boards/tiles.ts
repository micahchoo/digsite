import { existsSync, readFileSync } from 'node:fs';
import { TILE, type Zoom } from '@digsite/shared/board/grid';
import { ladderAddress, sizeFor } from '@digsite/shared/board/ladder';
// Composing one tile (CONTEXT.md "Tile"): a 256px PNG of the cells in one
// square of the map at one zoom, from the ladder pages, cached. See
// .claude/rules/ladder-slot-vs-rank.md and
// .claude/rules/tile-cache-is-for-the-second-viewer.md. Phase 1
// (docs/phases/1-map.md) adds two things: a pending image's slot paints a
// neutral cell instead of the ladder (and such a tile is never cached), and
// a materialised file on disk (boards/materialise.ts) is served ahead of
// composing at all, at z <= -3.
import { type Sort, sortId } from '@digsite/shared/board/sort';
import { createCanvas } from '@napi-rs/canvas';
import { pool } from '../db/pool.ts';
import { env } from '../env.ts';
import { getPage } from './ladder.ts';
import { slotsForTile } from './ranks.ts';
import { getComposedTile, setComposedTile } from './tiles-cache.ts';

const PENDING_COLOR = '#333';

export function materialisedTilePath(
  boardId: string,
  sid: string,
  z: Zoom,
  x: number,
  y: number,
): string {
  return `${env.DATA_DIR}/boards/${boardId}/tiles/${sid}/${z}/${x}-${y}.png`;
}

/** Which of these slots belong to a still-pending image — docs/phases/
 * 1-map.md "Tiles show a pending image as a neutral cell; a tile is not
 * cached while any of its slots is pending." */
export async function pendingSlotsFor(
  boardId: string,
  slots: (number | null)[],
): Promise<Set<number>> {
  const present = [...new Set(slots.filter((s): s is number => s !== null))];
  if (present.length === 0) return new Set();
  const { rows } = await pool.query(
    `SELECT slot FROM images WHERE board_id = $1 AND slot = ANY($2::int[]) AND status = 'pending'`,
    [boardId, present],
  );
  return new Set(rows.map((r) => r.slot as number));
}

export async function composeTile(
  boardId: string,
  cellPx: number,
  slots: (number | null)[],
  pendingSlots: Set<number> = new Set(),
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

    if (pendingSlots.has(slot)) {
      ctx.fillStyle = PENDING_COLOR;
      ctx.fillRect(col * cellPx, row * cellPx, cellPx, cellPx);
      continue;
    }

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
  cache: 'hit' | 'miss' | 'disk';
  rankMs: number;
  composeMs: number;
};

async function diskTileIfFresh(
  boardId: string,
  sid: string,
  z: Zoom,
  x: number,
  y: number,
): Promise<Buffer | null> {
  const { rows } = await pool.query(
    'SELECT stale, materialised_at FROM board_rank_state WHERE board_id = $1 AND sort_id = $2',
    [boardId, sid],
  );
  const state = rows[0];
  if (!state || state.stale || !state.materialised_at) return null;
  const path = materialisedTilePath(boardId, sid, z, x, y);
  if (!existsSync(path)) return null;
  return readFileSync(path);
}

/** Composes (or returns cached, or reads materialised) the PNG for one
 * tile. `cacheKey` is the request URL, per the composed-tile cache's
 * contract. */
export async function tileFor(
  boardId: string,
  sort: Sort,
  z: Zoom,
  x: number,
  y: number,
  cellPx: number,
  cacheKey: string,
): Promise<TileResult> {
  const sid = sortId(sort);

  if (z <= -3) {
    const disk = await diskTileIfFresh(boardId, sid, z, x, y);
    if (disk) return { png: disk, cache: 'disk', rankMs: 0, composeMs: 0 };
  }

  const cached = getComposedTile(cacheKey);
  if (cached) return { png: cached, cache: 'hit', rankMs: 0, composeMs: 0 };

  const rankStart = performance.now();
  const slots = await slotsForTile(boardId, sort, z, x, y);
  const pendingSlots = await pendingSlotsFor(boardId, slots);
  const rankMs = performance.now() - rankStart;

  const composeStart = performance.now();
  const png = await composeTile(boardId, cellPx, slots, pendingSlots);
  const composeMs = performance.now() - composeStart;

  if (pendingSlots.size === 0) setComposedTile(cacheKey, boardId, png);
  return { png, cache: 'miss', rankMs, composeMs };
}
