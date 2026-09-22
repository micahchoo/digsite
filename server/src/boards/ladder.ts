import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  LADDER,
  type LadderSize,
  PAGE,
  ladderAddress,
  perPage,
} from '@digsite/shared/board/ladder';
// The ladder (CONTEXT.md "Ladder"): an image's pixels at 8/32/128px, packed
// into 512px pages keyed by slot (never rank — .claude/rules/
// ladder-slot-vs-rank.md). Decoded pages are kept resident in one LRU across
// every open board, budgeted by LADDER_BUDGET_MB — that residency, not the
// composed-tile cache, is what makes a tile fast for the first viewer
// (.claude/rules/tile-cache-is-for-the-second-viewer.md).
import {
  type Canvas,
  type Image,
  createCanvas,
  loadImage,
} from '@napi-rs/canvas';
import { env } from '../env.ts';

const PAGE_BYTES = PAGE * PAGE * 4; // decoded RGBA
const MAX_PAGES = Math.max(
  1,
  Math.floor((env.LADDER_BUDGET_MB * 1024 * 1024) / PAGE_BYTES),
);

const cache = new Map<string, Canvas>(); // key: "boardId/S/page", LRU by insertion order

function cacheKey(boardId: string, s: LadderSize, page: number): string {
  return `${boardId}/${s}/${page}`;
}

function cacheGet(key: string): Canvas | undefined {
  const v = cache.get(key);
  if (v) {
    cache.delete(key);
    cache.set(key, v);
  }
  return v;
}

function cacheSet(key: string, v: Canvas): void {
  cache.set(key, v);
  while (cache.size > MAX_PAGES) {
    const oldest = cache.keys().next().value as string;
    cache.delete(oldest);
  }
}

export function ladderPagePath(
  boardId: string,
  s: LadderSize,
  page: number,
): string {
  return `${env.DATA_DIR}/boards/${boardId}/ladder/${s}/page-${page}.png`;
}

async function loadPageCanvas(
  boardId: string,
  s: LadderSize,
  page: number,
): Promise<Canvas> {
  const path = ladderPagePath(boardId, s, page);
  const canvas = createCanvas(PAGE, PAGE);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#222';
  ctx.fillRect(0, 0, PAGE, PAGE);
  if (existsSync(path)) {
    const img = await loadImage(readFileSync(path));
    ctx.drawImage(img, 0, 0);
  }
  return canvas;
}

/**
 * Warms every page of one ladder size for a board into the resident cache —
 * docs/phases/1-map.md "materialisation runs with the ladder resident (load
 * S=8 and S=32 pages for the board first)". Reading never writes to disk.
 */
export async function preloadPages(
  boardId: string,
  s: LadderSize,
  imageCount: number,
): Promise<void> {
  if (imageCount <= 0) return;
  const per = perPage(s);
  const maxPage = Math.floor((imageCount - 1) / per);
  for (let p = 0; p <= maxPage; p++) await getPage(boardId, s, p);
}

/** A decoded ladder page, cached. Reading never writes to disk. */
export async function getPage(
  boardId: string,
  s: LadderSize,
  page: number,
): Promise<Canvas> {
  const key = cacheKey(boardId, s, page);
  const hit = cacheGet(key);
  if (hit) return hit;
  const canvas = await loadPageCanvas(boardId, s, page);
  cacheSet(key, canvas);
  return canvas;
}

// Per-page async lock: two uploads landing on the same page must not race a
// read-modify-write of the PNG on disk.
const pageLocks = new Map<string, Promise<unknown>>();

function withPageLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = pageLocks.get(key) ?? Promise.resolve();
  const run = prior.then(fn, fn);
  pageLocks.set(
    key,
    run.catch(() => {}),
  );
  return run;
}

/**
 * Paints one uploaded image into every ladder size's page, square,
 * contained and centred on #222. Read page, draw, write page, under the
 * page's lock so a concurrent upload to the same page cannot lose a write.
 */
export async function paintLadder(
  boardId: string,
  slot: number,
  image: Image,
  imgWidth: number,
  imgHeight: number,
): Promise<void> {
  for (const s of LADDER) {
    const { page, x, y } = ladderAddress(slot, s);
    const key = cacheKey(boardId, s, page);
    await withPageLock(key, async () => {
      const canvas = await loadPageCanvas(boardId, s, page);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#222';
      ctx.fillRect(x, y, s, s);
      const scale = Math.min(s / imgWidth, s / imgHeight);
      const dw = imgWidth * scale;
      const dh = imgHeight * scale;
      const dx = x + (s - dw) / 2;
      const dy = y + (s - dh) / 2;
      ctx.drawImage(image, dx, dy, dw, dh);

      const path = ladderPagePath(boardId, s, page);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, canvas.encodeSync('png'));
      cacheSet(key, canvas);
    });
  }
}
