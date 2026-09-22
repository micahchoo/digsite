import { describe, expect, test } from 'bun:test';
// docs/phases/1-map.md "Tests": an upload leaves pending; running the
// worker once makes it ready with pages painted; a failing decode ends
// failed after three attempts.
import { ladderAddress } from '@digsite/shared/board/ladder';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { ladderPageKey } from '../boards/ladder.ts';
import { uploadOne } from '../boards/upload.ts';
import { pool } from '../db/pool.ts';
import { storageFromEnv } from '../storage/index.ts';
import { drain } from '../worker/index.ts';

async function makeBoard(name: string): Promise<string> {
  const { rows } = await pool.query(
    'INSERT INTO boards (org_id, name, open, created_by) VALUES ($1,$2,true,$3) RETURNING id',
    [`org-test-${Date.now()}`, name, 'test-user'],
  );
  return rows[0].id;
}

function paintSquare(hue: number): Buffer {
  const size = 48;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = `hsl(${hue}, 80%, 50%)`;
  ctx.fillRect(0, 0, size, size);
  return canvas.encodeSync('png');
}

function isBackground(px: Uint8ClampedArray): boolean {
  return px[0] === 0x22 && px[1] === 0x22 && px[2] === 0x22;
}

describe('worker', () => {
  test('an upload leaves pending; the worker paints the ladder and marks it ready', async () => {
    const boardId = await makeBoard(`worker-test-${Date.now()}`);
    const uploaded = await uploadOne(
      boardId,
      'tester',
      'a.png',
      paintSquare(30),
    );

    const before = await pool.query(
      'SELECT status, width, height FROM images WHERE id = $1',
      [uploaded.id],
    );
    expect(before.rows[0].status).toBe('pending');
    expect(before.rows[0].width).toBe(0);

    const processed = await drain();
    expect(processed).toBeGreaterThan(0);

    const after = await pool.query(
      'SELECT status, width, height FROM images WHERE id = $1',
      [uploaded.id],
    );
    expect(after.rows[0].status).toBe('ready');
    expect(after.rows[0].width).toBeGreaterThan(0);
    expect(after.rows[0].height).toBeGreaterThan(0);

    const { page, x, y } = ladderAddress(uploaded.slot, 32);
    const key = ladderPageKey(boardId, 32, page);
    const bytes = await storageFromEnv().get(key);
    if (!bytes) throw new Error(`ladder page missing: ${key}`);
    const img = await loadImage(Buffer.from(bytes));
    const full = createCanvas(img.width, img.height);
    full.getContext('2d').drawImage(img, 0, 0);
    const px = full.getContext('2d').getImageData(x + 16, y + 16, 1, 1).data;
    expect(isBackground(px)).toBe(false);
  });

  test('a failing decode ends failed after three attempts', async () => {
    const boardId = await makeBoard(`worker-fail-test-${Date.now()}`);
    const bad = new TextEncoder().encode('not a real image, just some bytes');
    const uploaded = await uploadOne(boardId, 'tester', 'bad.png', bad);

    await drain();

    const { rows } = await pool.query(
      'SELECT status, error FROM images WHERE id = $1',
      [uploaded.id],
    );
    expect(rows[0].status).toBe('failed');
    expect(typeof rows[0].error).toBe('string');
    expect((rows[0].error as string).length).toBeGreaterThan(0);

    const jobRows = await pool.query(
      `SELECT state, attempts FROM jobs WHERE kind = 'ladder' AND payload->>'imageId' = $1`,
      [uploaded.id],
    );
    expect(jobRows.rows[0].state).toBe('failed');
    expect(jobRows.rows[0].attempts).toBe(3);
  });
});
