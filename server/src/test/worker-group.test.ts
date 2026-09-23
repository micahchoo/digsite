import { describe, expect, test } from 'bun:test';
// worker/jobs.ts#runLadderGroup: ladder jobs that share an S=128 page are
// painted together, and one bad file fails only its own job.
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

function square(hue: number): Buffer {
  const canvas = createCanvas(32, 32);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = `hsl(${hue}, 80%, 50%)`;
  ctx.fillRect(0, 0, 32, 32);
  return canvas.encodeSync('png');
}

describe('page-grouped ladder jobs', () => {
  test('one bad file fails alone; its page-mates are painted', async () => {
    const boardId = await makeBoard(`group-${Date.now()}`);
    const good = [];
    for (let i = 0; i < 3; i++) {
      good.push(await uploadOne(boardId, 't', `${i}.png`, square(i * 120)));
    }
    const bad = await uploadOne(
      boardId,
      't',
      'bad.png',
      new TextEncoder().encode('not an image'),
    );
    await drain();

    const { rows } = await pool.query(
      'SELECT id, status FROM images WHERE board_id = $1',
      [boardId],
    );
    const status = new Map(rows.map((r) => [r.id, r.status]));
    for (const image of good) expect(status.get(image.id)).toBe('ready');
    expect(status.get(bad.id)).toBe('failed');

    // All four slots share one S=32 page; the three good ones are painted.
    const bytes = await storageFromEnv().get(
      ladderPageKey(boardId, 32, ladderAddress(good[0]?.slot ?? 0, 32).page),
    );
    if (!bytes) throw new Error('page missing');
    const img = await loadImage(Buffer.from(bytes));
    const page = createCanvas(img.width, img.height);
    page.getContext('2d').drawImage(img, 0, 0);
    for (const image of good) {
      const { x, y } = ladderAddress(image.slot, 32);
      const px = page.getContext('2d').getImageData(x + 16, y + 16, 1, 1).data;
      expect([px[0], px[1], px[2]]).not.toEqual([0x22, 0x22, 0x22]);
    }
  });
});
