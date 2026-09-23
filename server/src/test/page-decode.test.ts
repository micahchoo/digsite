import { describe, expect, test } from 'bun:test';
// boards/ladder.ts#decodePage: a ladder page that @napi-rs/canvas wrote and
// cannot read back. Found in both 4 GB soaks (2026-09-23): it failed every
// later paint on its page, stranding 13 images.
import { join } from 'node:path';
import { loadImage } from '@napi-rs/canvas';
import sharp from 'sharp';
import { getPage, ladderPageKey } from '../boards/ladder.ts';
import { storageFromEnv } from '../storage/index.ts';

const FIXTURE = join(import.meta.dir, 'fixtures/page-canvas-cannot-read.png');

describe('reading a stored ladder page', () => {
  test('the canvas library still cannot read this page', async () => {
    // If this starts passing, an upgrade fixed it upstream and decodePage's
    // reason to exist is gone; the test below still guards the behaviour.
    await expect(
      loadImage(Buffer.from(await Bun.file(FIXTURE).arrayBuffer())),
    ).rejects.toThrow();
  });

  test('getPage reads it, pixel for pixel', async () => {
    const bytes = new Uint8Array(await Bun.file(FIXTURE).arrayBuffer());
    const boardId = crypto.randomUUID();
    await storageFromEnv().put(
      ladderPageKey(boardId, 128, 0),
      bytes,
      'image/png',
    );

    const canvas = await getPage(boardId, 128, 0);
    const got = canvas.getContext('2d').getImageData(0, 0, 512, 512).data;
    const want = await sharp(bytes).ensureAlpha().raw().toBuffer();
    let differing = 0;
    for (let i = 0; i < want.length; i++) if (got[i] !== want[i]) differing++;
    expect(differing).toBe(0);
  });
});
