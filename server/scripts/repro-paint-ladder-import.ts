// Isolates the upload worker's ladder paint: `paintLadder` over real image
// files, with a temporary DATA_DIR and no database. A 20,000-file import
// grew the server by ~1.14 MB per processed image and passed 16 GB
// (docs/measurements/bulk-import-20000.md); this reproduces that slope.
//
//   DATA_DIR=$(mktemp -d) bun run scripts/repro-paint-ladder-import.ts <dir> [count]
//
// Each image is also read back through `withPage`, as an open board's
// tiles would. Fails if RSS grows more than 128 MB over 600 or more images.
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ladderAddress } from '@digsite/shared/board/ladder';
import { createCanvas } from '@napi-rs/canvas';
import { paintLadder, withPage } from '../src/boards/ladder.ts';
import { env } from '../src/env.ts';

const dir = Bun.argv[2];
if (!dir) throw new Error('usage: repro-paint-ladder-import.ts <dir> [count]');
const count = Number(Bun.argv[3] ?? 600);
if (!env.DATA_DIR.includes('tmp')) {
  throw new Error(`refusing DATA_DIR outside a temp dir: ${env.DATA_DIR}`);
}
const files = readdirSync(dir)
  .filter((name) => /\.(png|jpe?g|webp)$/i.test(name))
  .sort()
  .slice(0, count);
const rssMB = () => Math.round(process.memoryUsage().rss / 1048576);
const boardId = crypto.randomUUID();
// A board stays open during an import, so tiles read freshly painted pages
// as draw sources. One reused tile canvas, as tiles.ts pools its own.
const tile = createCanvas(256, 256);
const tileCtx = tile.getContext('2d');

try {
  // Warm up past first-use allocations before taking the baseline.
  const warm = Math.min(50, files.length);
  let startRss = 0;
  for (let slot = 0; slot < files.length; slot++) {
    await paintLadder(
      boardId,
      slot,
      readFileSync(join(dir, files[slot] as string)),
    );
    await withPage(boardId, 128, ladderAddress(slot, 128).page, (page) => {
      tileCtx.drawImage(page, 0, 0, 256, 256);
    });
    // tiles.ts encodes every composed tile; a canvas holds what was drawn
    // into it until it is encoded or resized, so the probe must too.
    tile.encodeSync('png');
    if (slot + 1 === warm) {
      Bun.gc(true);
      startRss = rssMB();
    }
    if ((slot + 1) % 100 === 0) {
      Bun.gc(true);
      console.log(`images=${slot + 1} rssMB=${rssMB()}`);
    }
  }
  Bun.gc(true);
  const growth = rssMB() - startRss;
  console.log(`done images=${files.length} rssMB=${rssMB()} deltaMB=${growth}`);
  if (files.length >= 600 && growth > 128) {
    throw new Error(
      `paintLadder RSS grew ${growth} MB; expected at most 128 MB`,
    );
  }
} finally {
  rmSync(join(env.DATA_DIR, 'boards', boardId), {
    recursive: true,
    force: true,
  });
}
