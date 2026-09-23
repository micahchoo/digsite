import { describe, expect, test } from 'bun:test';
// docs/phases/1-map.md "Tests", extended by docs/measurements/phase-1-map.md
// "Row 4"'s fix: after a rebuild + materialise on a 3,000-image board, every
// z=-3 tile file exists on disk, the route serves it resident
// (boards/coarse-cache.ts, populated by materialiseSort itself — no second
// disk read), and the scatter path's output is pixel-identical to the old
// per-tile GATHER (slotsForTile + composeTile) it replaced, at every
// materialised zoom (z=-3, -4, -5), not just z=-3. Built by direct SQL
// (images) + direct ladder page painting (paintLadder), bypassing
// uploadOne/the worker for speed — every row and page this writes is what
// the real upload path writes, just without going through 3,000 HTTP
// requests.
import {
  CELL,
  type Zoom,
  cellPx,
  perTileSide,
  worldExtent,
} from '@digsite/shared/board/grid';
import { DEFAULT_SORT, sortId } from '@digsite/shared/board/sort';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { paintLadder } from '../boards/ladder.ts';
import { materialiseSort, tileGrid } from '../boards/materialise.ts';
import { ensureRank, slotsForTile } from '../boards/ranks.ts';
import {
  composeTile,
  materialisedTileKey,
  pendingSlotsFor,
  tileFor,
} from '../boards/tiles.ts';
import { pool } from '../db/pool.ts';
import { env } from '../env.ts';
import { storageFromEnv } from '../storage/index.ts';

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

async function decodePixels(png: Buffer): Promise<Uint8ClampedArray> {
  const img = await loadImage(png);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, img.width, img.height).data;
}

describe('materialise', () => {
  test('legacy wide-grid tiles are ignored after compact layout upgrade', async () => {
    const boardId = await makeBoard(`grid-upgrade-${Date.now()}`);
    await makeImage(boardId, 0);
    await pool.query('UPDATE boards SET image_count = 1 WHERE id = $1', [
      boardId,
    ]);
    const image = await loadImage(paintSquare(90));
    await paintLadder(boardId, 0, image, image.width, image.height);
    await ensureRank(boardId, DEFAULT_SORT);
    const sid = sortId(DEFAULT_SORT);
    await pool.query(
      'UPDATE board_rank_state SET materialised_at = now() WHERE board_id = $1',
      [boardId],
    );
    const legacy = `boards/${boardId}/tiles/${sid}/-3/0-0.png`;
    await storageFromEnv().put(legacy, paintSquare(270), 'image/png');
    const result = await tileFor(
      boardId,
      DEFAULT_SORT,
      -3,
      0,
      0,
      cellPx(-3),
      `/boards/${boardId}/tiles/${sid}/-3/0/0.png?grid=2`,
    );
    expect(result.cache).toBe('miss');
    expect((await loadImage(result.png)).width).toBe(256);
    expect(materialisedTileKey(boardId, sid, -3, 0, 0)).not.toBe(legacy);
    await materialiseSort(boardId, DEFAULT_SORT);
    expect(await storageFromEnv().get(legacy)).toBeNull();
  });

  test('z=-3 tiles exist on disk after rebuild + materialise, and the route serves them resident', async () => {
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
    const storage = storageFromEnv();
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const key = materialisedTileKey(boardId, sid, -3, x, y);
        expect(await storage.exists(key)).toBe(true);
      }
    }

    // materialiseSort hands its own just-encoded buffers to the resident
    // cache — the route must never have to re-read disk for this request.
    // Decoded, not just checked for the `resident` label: the resident
    // buffer used to be raw RGBA (materialise.ts's pre-phase-4 bug, fixed
    // alongside the Storage refactor — see materialise.ts's TileEntry
    // comment), which this test's earlier form never caught because it
    // only asserted the cache label, never that the bytes were a real PNG.
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
    expect(result.cache).toBe('resident');
    const decoded = await loadImage(result.png);
    expect(decoded.width).toBeGreaterThan(0);
    expect(decoded.height).toBeGreaterThan(0);
  }, 60_000);

  test('scatter output is pixel-identical to the per-tile compose, 20 random coarse tiles', async () => {
    const boardId = await makeBoard(`materialise-pixel-test-${Date.now()}`);

    for (let i = 0; i < N; i++) await makeImage(boardId, i);
    await pool.query('UPDATE boards SET image_count = $1 WHERE id = $2', [
      N,
      boardId,
    ]);
    for (let i = 0; i < N; i++) {
      const img = await loadImage(paintSquare((i * 89) % 360));
      await paintLadder(boardId, i, img, img.width, img.height);
    }

    await ensureRank(boardId, DEFAULT_SORT);
    await materialiseSort(boardId, DEFAULT_SORT);
    const sid = sortId(DEFAULT_SORT);

    const zooms: Zoom[] = [-3, -4, -5];
    const picks: { z: Zoom; x: number; y: number }[] = [];
    for (let i = 0; i < 20; i++) {
      const z = zooms[i % zooms.length] as Zoom;
      const { nx, ny } = tileGrid(N, z);
      picks.push({
        z,
        x: Math.floor(Math.random() * nx),
        y: Math.floor(Math.random() * ny),
      });
    }

    const storage = storageFromEnv();
    for (const { z, x, y } of picks) {
      const key = materialisedTileKey(boardId, sid, z, x, y);
      const bytes = await storage.get(key);
      if (!bytes) throw new Error(`materialised tile missing: ${key}`);
      const scattered = Buffer.from(bytes);

      const slots = await slotsForTile(boardId, DEFAULT_SORT, z, x, y);
      const pendingSlots = await pendingSlotsFor(boardId, slots);
      const composed = await composeTile(
        boardId,
        cellPx(z),
        slots,
        pendingSlots,
      );

      const scatteredPixels = await decodePixels(scattered);
      const composedPixels = await decodePixels(composed);
      expect(scatteredPixels).toEqual(composedPixels);
    }
  }, 60_000);

  // docs/phases/5-hardening.md section 5: "Materialisation enforces its own
  // cap ... refusing loudly before it would exceed; a test proves the
  // refusal." MATERIALISE_BUDGET_MB is a plain mutable field on `env` (see
  // env.ts) — no other test in this file (or, checked, any other file)
  // calls materialiseSort concurrently, so overriding it for the duration
  // of this test and restoring it in `finally` doesn't race anything else.
  test('materialiseSort refuses loudly instead of exceeding MATERIALISE_BUDGET_MB', async () => {
    const boardId = await makeBoard(`materialise-budget-test-${Date.now()}`);

    for (let i = 0; i < N; i++) await makeImage(boardId, i);
    await pool.query('UPDATE boards SET image_count = $1 WHERE id = $2', [
      N,
      boardId,
    ]);
    for (let i = 0; i < N; i++) {
      const img = await loadImage(paintSquare((i * 53) % 360));
      await paintLadder(boardId, i, img, img.width, img.height);
    }
    await ensureRank(boardId, DEFAULT_SORT);

    const before = env.MATERIALISE_BUDGET_MB;
    env.MATERIALISE_BUDGET_MB = 0; // even one 256x256 RGBA tile canvas is 256KB
    try {
      await expect(materialiseSort(boardId, DEFAULT_SORT)).rejects.toThrow(
        /materialise: budget exceeded/,
      );
    } finally {
      env.MATERIALISE_BUDGET_MB = before;
    }

    // The refusal must be BEFORE any tile is written for this sort — a
    // partial, silently-incomplete materialise would be worse than none.
    const sid = sortId(DEFAULT_SORT);
    const storage = storageFromEnv();
    const key = materialisedTileKey(boardId, sid, -3, 0, 0);
    expect(await storage.exists(key)).toBe(false);

    // And board_rank_state never gets a materialised_at for this refused
    // attempt — the tile route must keep falling through to compose, not
    // believe a materialise that never finished.
    const { rows } = await pool.query(
      'SELECT materialised_at FROM board_rank_state WHERE board_id = $1 AND sort_id = $2',
      [boardId, sid],
    );
    expect(rows[0]?.materialised_at ?? null).toBeNull();
  }, 60_000);
});
