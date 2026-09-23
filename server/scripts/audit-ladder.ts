// Every ready image of a board must be painted at every ladder size. A cell
// whose pixels are all the page background (#222) was never painted — or
// was painted and then lost, which is what two workers writing one page
// without a lock would do (storage/lock.ts). Reads pages with libvips, the
// only decoder that reads every page (ladder.ts#decodePage).
//
//   DATA_DIR=... DATABASE_URL=... bun run scripts/audit-ladder.ts <boardId>
//
// Exits 1 if any cell is blank.
import {
  LADDER,
  type LadderSize,
  ladderAddress,
} from '@digsite/shared/board/ladder';
import type { ImageData } from '@napi-rs/canvas';
import { decodePage, ladderPageKey } from '../src/boards/ladder.ts';
import { pool } from '../src/db/pool.ts';
import { storageFromEnv } from '../src/storage/index.ts';

const arg = Bun.argv[2];
if (!arg) throw new Error('usage: audit-ladder.ts <boardId>');
const boardId: string = arg;

const { rows } = await pool.query<{ slot: number }>(
  `SELECT slot FROM images WHERE board_id = $1 AND status = 'ready' ORDER BY slot`,
  [boardId],
);
const pages = new Map<string, ImageData | null>();
const blank: { slot: number; s: LadderSize }[] = [];

async function page(s: LadderSize, n: number): Promise<ImageData | null> {
  const key = `${s}/${n}`;
  if (!pages.has(key)) {
    const bytes = await storageFromEnv().get(ladderPageKey(boardId, s, n));
    pages.set(key, bytes ? await decodePage(bytes) : null);
  }
  return pages.get(key) ?? null;
}

for (const { slot } of rows) {
  for (const s of LADDER) {
    const { page: n, x, y } = ladderAddress(slot, s);
    const pixels = await page(s, n);
    let painted = false;
    for (let dy = 0; dy < s && !painted && pixels; dy++) {
      for (let dx = 0; dx < s; dx++) {
        const i = ((y + dy) * pixels.width + (x + dx)) * 4;
        const d = pixels.data;
        if (d[i] !== 0x22 || d[i + 1] !== 0x22 || d[i + 2] !== 0x22) {
          painted = true;
          break;
        }
      }
    }
    if (!painted) blank.push({ slot, s });
  }
}

console.log(
  JSON.stringify({
    boardId,
    ready: rows.length,
    cells: rows.length * LADDER.length,
    blank: blank.length,
    firstBlank: blank.slice(0, 10),
  }),
);
await pool.end();
if (blank.length > 0) process.exit(1);
