import { describe, expect, test } from 'bun:test';
// docs/phases/1-map.md "Tests": after a rebuild + materialise on a
// 3,000-image board, every z=-3 tile file exists and the route serves it
// with X-Cache: disk. Built by direct SQL (images) + direct ladder page
// painting (paintLadder), bypassing uploadOne/the worker for speed — every
// row and page this writes is what the real upload path writes, just
// without going through 3,000 HTTP requests.
import { existsSync } from 'node:fs';
import {
  CELL,
  cellPx,
  perTileSide,
  worldExtent,
} from '@digsite/shared/board/grid';
import { DEFAULT_SORT, sortId } from '@digsite/shared/board/sort';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { paintLadder } from '../boards/ladder.ts';
import { materialiseSort } from '../boards/materialise.ts';
import { ensureRank } from '../boards/ranks.ts';
import { materialisedTilePath, tileFor } from '../boards/tiles.ts';
import { pool } from '../db/pool.ts';

const N = 3000;

async function makeBoard(name: string): Promise<string> {
  const { rows } = await pool.query(
    'INSERT INTO boards (org_id, name, open, created_by) VALUES ($1,$2,true,$3) RETURNING id',
    [`org-test-${Date.now()}`, name, 'test-user'],
  );
  return rows[0].id;
}

async function makeImage(boardId: string, slot: number): Promise<void> {
  await pool.query(
    `INSERT INTO images (board_id, slot, sha256, name, width, height, uploaded_by, properties)
     VALUES ($1,$2,$3,$4,40,40,'tester','{}')`,
    [boardId, slot, `sha-${slot}`, `img-${slot}`],
  );
}

function paintSquare(hue: number): Buffer {
  const size = 40;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = `hsl(${hue}, 80%, 50%)`;
  ctx.fillRect(0, 0, size, size);
  return canvas.encodeSync('png');
}

describe('materialise', () => {
  test('z=-3 tiles exist on disk after rebuild + materialise, and the route serves them with X-Cache: disk', async () => {
    const boardId = await makeBoard(`materialise-test-${Date.now()}`);

    for (let i = 0; i < N; i++) await makeImage(boardId, i);
    await pool.query('UPDATE boards SET image_count = $1 WHERE id = $2', [
      N,
      boardId,
    ]);
    for (let i = 0; i < N; i++) {
      const img = await loadImage(paintSquare((i * 137.508) % 360));
      await paintLadder(boardId, i, img, img.width, img.height);
    }

    const { built } = await ensureRank(boardId, DEFAULT_SORT);
    expect(built).toBe(true);

    const { tiles } = await materialiseSort(boardId, DEFAULT_SORT);
    expect(tiles).toBeGreaterThan(0);

    const sid = sortId(DEFAULT_SORT);
    const [, , w, h] = worldExtent(N);
    const side = perTileSide(-3) * CELL;
    const nx = Math.ceil(w / side);
    const ny = Math.ceil(h / side);
    expect(nx * ny).toBeGreaterThan(0);
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const path = materialisedTilePath(boardId, sid, -3, x, y);
        expect(existsSync(path)).toBe(true);
      }
    }

    const cacheKey = `/boards/${boardId}/tiles/${sid}/-3/0/0.png`;
    const result = await tileFor(
      boardId,
      DEFAULT_SORT,
      -3,
      0,
      0,
      cellPx(-3),
      cacheKey,
    );
    expect(result.cache).toBe('disk');
  }, 60_000);
});
