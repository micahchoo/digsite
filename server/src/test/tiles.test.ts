import { describe, expect, test } from 'bun:test';
import { DEFAULT_SORT } from '@digsite/shared/board/sort';
// docs/design.md "Tests": tile (0,0,0) of the seeded board has four painted
// cells; X-Cache is miss then hit.
//
// z=0's tile (0,0,0) covers ranks 0, 1, 16 and 17 — COLS=16
// (shared/src/board/grid.ts) means a board needs >=1026 images before a
// rank lands in the tile's second row. This test builds a small board, so
// only ranks 0 and 1 are in range; those are the two cells asserted
// painted. The literal "four painted cells" curl check in the definition
// of done needs a board that size — see server/README.md for how that was
// verified separately, and .claude/rules/ladder-slot-vs-rank.md for why
// slot and rank are never the same address.
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { tileFor } from '../boards/tiles.ts';
import { uploadOne } from '../boards/upload.ts';
import { pool } from '../db/pool.ts';
import { drain } from '../worker/index.ts';

async function makeBoard(name: string): Promise<string> {
  const { rows } = await pool.query(
    'INSERT INTO boards (org_id, name, open, created_by) VALUES ($1,$2,true,$3) RETURNING id',
    [`org-test-${Date.now()}`, name, 'test-user'],
  );
  return rows[0].id;
}

function paintSquare(hue: number): Buffer {
  const size = 40;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = `hsl(${hue}, 80%, 50%)`;
  ctx.fillRect(0, 0, size, size);
  return canvas.encodeSync('png');
}

function isBackground(px: Uint8ClampedArray): boolean {
  return px[0] === 0x22 && px[1] === 0x22 && px[2] === 0x22;
}

describe('tiles', () => {
  test('tile (0,0,0): in-range cells painted, out-of-range cells blank; X-Cache miss then hit', async () => {
    const boardId = await makeBoard(`tiles-test-${Date.now()}`);
    await uploadOne(boardId, 'tester', 'a.png', paintSquare(0));
    await uploadOne(boardId, 'tester', 'b.png', paintSquare(160));
    // docs/phases/1-map.md: painting moved to the worker — drain it so
    // these two land `ready` before composing (a pending slot would paint
    // the neutral #333 cell this test doesn't expect).
    await drain();

    const cacheKey = `/boards/${boardId}/tiles/${'uploaded_at.desc'}/0/0/0.png`;

    const r1 = await tileFor(boardId, DEFAULT_SORT, 0, 0, 0, 128, cacheKey);
    expect(r1.cache).toBe('miss');

    const img = await loadImage(r1.png);
    const canvas = createCanvas(img.width, img.height);
    canvas.getContext('2d').drawImage(img, 0, 0);
    const ctx = canvas.getContext('2d');

    // rank 0 -> cell (col0,row0) center (64,64); rank 1 -> (col1,row0) center (192,64)
    expect(isBackground(ctx.getImageData(64, 64, 1, 1).data)).toBe(false);
    expect(isBackground(ctx.getImageData(192, 64, 1, 1).data)).toBe(false);
    // rank 16/17 don't exist on a 2-image board -> blank cells
    expect(
      isBackground(ctx.getImageData(64, 192, 1, 1).data) ||
        ctx.getImageData(64, 192, 1, 1).data[3] === 0,
    ).toBe(true);

    const r2 = await tileFor(boardId, DEFAULT_SORT, 0, 0, 0, 128, cacheKey);
    expect(r2.cache).toBe('hit');
    expect(r2.png.equals(r1.png)).toBe(true);
  });
});
