import { describe, expect, test } from 'bun:test';
import { ladderAddress } from '@digsite/shared/board/ladder';
// docs/design.md "Tests": upload two files; slots 0 and 1; ladder pages
// exist; ladderAddress finds non-transparent pixels. Since docs/phases/
// 1-map.md, painting moved to the worker — the request only enqueues the
// `ladder` job, so this test drains it once before checking the pages.
import { createCanvas } from '@napi-rs/canvas';
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
  const size = 64;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = `hsl(${hue}, 80%, 50%)`;
  ctx.fillRect(0, 0, size, size);
  return canvas.encodeSync('png');
}

describe('upload', () => {
  test('two uploads get slots 0 and 1; every ladder size is painted, non-background', async () => {
    const boardId = await makeBoard(`upload-test-${Date.now()}`);

    const a = await uploadOne(boardId, 'tester', 'a.png', paintSquare(0));
    const b = await uploadOne(boardId, 'tester', 'b.png', paintSquare(200));

    expect(a.slot).toBe(0);
    expect(b.slot).toBe(1);
    expect(a.status).toBe('pending');

    await drain();

    const { rows } = await pool.query(
      'SELECT status FROM images WHERE id = ANY($1::uuid[])',
      [[a.id, b.id]],
    );
    expect(rows.every((r) => r.status === 'ready')).toBe(true);

    const { loadImage } = await import('@napi-rs/canvas');
    const storage = storageFromEnv();

    for (const slot of [a.slot, b.slot]) {
      for (const s of [8, 32, 128] as const) {
        const { page, x, y } = ladderAddress(slot, s);
        const key = ladderPageKey(boardId, s, page);
        const bytes = await storage.get(key);
        if (!bytes) throw new Error(`ladder page missing: ${key}`);
        const img = await loadImage(Buffer.from(bytes));
        const full = createCanvas(img.width, img.height);
        full.getContext('2d').drawImage(img, 0, 0);
        const px = full
          .getContext('2d')
          .getImageData(
            x + Math.floor(s / 2),
            y + Math.floor(s / 2),
            1,
            1,
          ).data;
        const isBackground = px[0] === 0x22 && px[1] === 0x22 && px[2] === 0x22;
        expect(isBackground).toBe(false);
      }
    }
  });
});
