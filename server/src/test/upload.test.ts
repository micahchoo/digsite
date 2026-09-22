import { describe, expect, test } from 'bun:test';
import { ladderAddress } from '@digsite/shared/board/ladder';
// docs/design.md "Tests": upload two files; slots 0 and 1; ladder pages
// exist; ladderAddress finds non-transparent pixels.
import { createCanvas } from '@napi-rs/canvas';
import { ladderPagePath } from '../boards/ladder.ts';
import { uploadOne } from '../boards/upload.ts';
import { pool } from '../db/pool.ts';

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

    const { loadImage } = await import('@napi-rs/canvas');
    const { readFileSync } = await import('node:fs');

    for (const slot of [a.slot, b.slot]) {
      for (const s of [8, 32, 128] as const) {
        const { page, x, y } = ladderAddress(slot, s);
        const path = ladderPagePath(boardId, s, page);
        const img = await loadImage(readFileSync(path));
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
