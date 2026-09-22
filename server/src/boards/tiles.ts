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
import { storageFromEnv } from '../storage/index.ts';
import { getResidentTile, loadResidentSortFromDisk } from './coarse-cache.ts';
import { getPage } from './ladder.ts';
import { slotsForTile } from './ranks.ts';
import { getComposedTile, setComposedTile } from './tiles-cache.ts';

// Shared with materialise.ts's scatter path, so a pending slot paints the
// same cell whichever path composed the tile.
export const PENDING_COLOR = '#333';

export function materialisedTileKey(
  boardId: string,
  sid: string,
  z: Zoom,
  x: number,
  y: number,
): string {
  return `boards/${boardId}/tiles/${sid}/${z}/${x}-${y}.png`;
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
  cache: 'hit' | 'miss' | 'disk' | 'resident';
  rankMs: number;
  composeMs: number;
};

async function rankStateFresh(boardId: string, sid: string): Promise<boolean> {
  const { rows } = await pool.query(
    'SELECT stale, materialised_at FROM board_rank_state WHERE board_id = $1 AND sort_id = $2',
    [boardId, sid],
  );
  const state = rows[0];
  return !!state && !state.stale && !!state.materialised_at;
}

/** Serves a z<=-3 tile once (board, sort) is materialised and not stale —
 * boards/coarse-cache.ts's resident map first (`X-Cache: resident`,
 * populated by materialiseSort right after it encodes, or lazily here on a
 * board whose files exist but this process hasn't held them yet), disk
 * (`X-Cache: disk`) when the sort is too big for COARSE_BUDGET_MB. Returns
 * null when there is nothing materialised and fresh to serve — the caller
 * falls through to composing. */
async function materialisedTile(
  boardId: string,
  sid: string,
  z: Zoom,
  x: number,
  y: number,
): Promise<{ png: Buffer; cache: 'disk' | 'resident' } | null> {
  const resident = getResidentTile(boardId, sid, z, x, y);
  if (resident) return { png: resident, cache: 'resident' };

  if (!(await rankStateFresh(boardId, sid))) return null;

  if (await loadResidentSortFromDisk(boardId, sid)) {
    const loaded = getResidentTile(boardId, sid, z, x, y);
    if (loaded) return { png: loaded, cache: 'resident' };
  }

  const key = materialisedTileKey(boardId, sid, z, x, y);
  const bytes = await storageFromEnv().get(key);
  if (!bytes) return null;
  return { png: Buffer.from(bytes), cache: 'disk' };
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
    const materialised = await materialisedTile(boardId, sid, z, x, y);
    if (materialised) return { ...materialised, rankMs: 0, composeMs: 0 };
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
