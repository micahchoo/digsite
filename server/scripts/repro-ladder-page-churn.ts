// Isolates the real ladder read/recycle path: repeated `getPage` misses with
// a one-page cache, local synthetic PNGs, and no DB or demo storage. Run with
// LADDER_BUDGET_MB=0 so MAX_PAGES is one, and under a process memory limit:
// `prlimit --data=2147483648 -- env LADDER_BUDGET_MB=0 bun run scripts/repro-ladder-page-churn.ts 250`
// Add `no-reset` as the second argument to demonstrate the materialise-path
// growth without the canvas dimension reset.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PAGE } from '@digsite/shared/board/ladder';
import { Image, createCanvas } from '@napi-rs/canvas';
import {
  getPage,
  ladderPageKey,
  maxPagesForTest,
  residentPagesForTest,
} from '../src/boards/ladder.ts';
import { env } from '../src/env.ts';

const count = Number(Bun.argv[2] ?? 250);
const resetMaterialiseCanvas = Bun.argv[3] !== 'no-reset';
if (!Number.isSafeInteger(count) || count < 2 || count > 1000) {
  throw new Error('page count must be an integer between 2 and 1000');
}
if (maxPagesForTest() !== 1) {
  throw new Error('run with LADDER_BUDGET_MB=0 to force a one-page cache');
}

const root = await mkdtemp(join(tmpdir(), 'digsite-ladder-churn-'));
env.DATA_DIR = root;
const boardId = 'synthetic-ladder-churn';

function rssMB(): number {
  return Math.round(process.memoryUsage().rss / 1024 / 1024);
}

const startRss = rssMB();
const source = createCanvas(PAGE, PAGE);
const sourceContext = source.getContext('2d');

try {
  for (let page = 0; page < count; page++) {
    const red = page & 0xff;
    const green = (page >> 8) & 0xff;
    const blue = (page >> 16) & 0xff;
    sourceContext.fillStyle = `rgb(${red}, ${green}, ${blue})`;
    sourceContext.fillRect(0, 0, PAGE, PAGE);
    const key = ladderPageKey(boardId, 128, page);
    const path = join(root, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, source.encodeSync('png'));
  }

  console.log(`pages=${count} maxPages=1 startRssMB=${startRss}`);
  for (let page = 0; page < count; page++) {
    const canvas = await getPage(boardId, 128, page);
    const pixel = canvas.getContext('2d').getImageData(256, 256, 1, 1).data;
    const expected = [page & 0xff, (page >> 8) & 0xff, (page >> 16) & 0xff];
    if (
      pixel[0] !== expected[0] ||
      pixel[1] !== expected[1] ||
      pixel[2] !== expected[2]
    ) {
      throw new Error(
        `page ${page} pixel mismatch: ${[...pixel]} !== ${expected}`,
      );
    }
    if (page % 50 === 49) {
      Bun.gc(true);
      console.log(`page=${page + 1} rssMB=${rssMB()}`);
    }
  }
  Bun.gc(true);
  const ladderGrowthMB = rssMB() - startRss;
  console.log(
    `done pages=${count} resident=${residentPagesForTest(boardId)} rssMB=${rssMB()} deltaMB=${ladderGrowthMB}`,
  );
  if (residentPagesForTest(boardId) !== 1) {
    throw new Error('the one-page cache did not retain exactly one page');
  }
  // The reproduced leak adds about 1 MB per miss. This generous allowance
  // separates that growth from allocator noise in the fixed implementation.
  if (count >= 250 && ladderGrowthMB > 128) {
    throw new Error(
      `ladder RSS grew ${ladderGrowthMB} MB; expected at most 128 MB`,
    );
  }

  // materialise.ts#paintPageDirect reuses one Image and one source canvas
  // across page PNGs. This isolated operation demonstrates the same native
  // behavior; it does not call materialiseSort or replace its pixel tests.
  const pageCanvas = createCanvas(PAGE, PAGE);
  const image = new Image();
  const materialisePng = source.encodeSync('png');
  const materialiseStartRss = rssMB();
  for (let page = 0; page < count; page++) {
    if (resetMaterialiseCanvas) {
      pageCanvas.width = PAGE;
      pageCanvas.height = PAGE;
    }
    const context = pageCanvas.getContext('2d');
    image.src = Buffer.from(materialisePng);
    await image.decode();
    context.fillStyle = '#222';
    context.fillRect(0, 0, PAGE, PAGE);
    context.drawImage(image, 0, 0);
    const pixel = context.getImageData(256, 256, 1, 1).data;
    const expected = [
      (count - 1) & 0xff,
      ((count - 1) >> 8) & 0xff,
      ((count - 1) >> 16) & 0xff,
    ];
    if (
      pixel[0] !== expected[0] ||
      pixel[1] !== expected[1] ||
      pixel[2] !== expected[2]
    ) {
      throw new Error(
        `materialise page ${page} pixel mismatch: ${[...pixel]} !== ${expected}`,
      );
    }
    if (page % 50 === 49) {
      Bun.gc(true);
      console.log(`materialisePage=${page + 1} rssMB=${rssMB()}`);
    }
  }
  Bun.gc(true);
  const materialiseGrowthMB = rssMB() - materialiseStartRss;
  console.log(
    `materialise done pages=${count} rssMB=${rssMB()} deltaMB=${materialiseGrowthMB}`,
  );
  if (resetMaterialiseCanvas && count >= 250 && materialiseGrowthMB > 128) {
    throw new Error(
      `decoded-image RSS grew ${materialiseGrowthMB} MB; expected at most 128 MB`,
    );
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
