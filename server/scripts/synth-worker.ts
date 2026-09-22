// Paints one page job: (boardId, ladder size, page number, slots on that
// page) — load the page if it already exists on disk (so a page that
// straddles two batches keeps earlier slots), draw every new slot's cell,
// write it back. Spawned as a Bun Worker by synth.ts, one pool reused
// across every batch — see server/scripts/synth.ts and
// docs/phases/1-map.md section 4.
//
// The recipe (hue = slot * 137.508 mod 360 golden angle, sat 65%, light
// 55%, darker diagonal band, slot number at S=128) is
// ../../../prototype/board/CONTRACT.md's ladder recipe, ported unchanged.
// The page file format (path, 512px page, cell offsets) is
// server/src/boards/ladder.ts#ladderPageKey / paintLadder's own layout —
// imported directly so synth's pages are the same files the upload path
// would have written for these slots. Writes straight to disk under
// DATA_DIR (never through storage/index.ts's Storage) on purpose: this is
// a benchmark-only bulk generator for the synthetic million-image board
// (docs/phases/1-map.md section 4), not a request path, and the whole
// point is painting pages as fast as raw fs calls allow — a key is,
// byte-for-byte, its path relative to DATA_DIR (storage/fs.ts), so joining
// them here reproduces exactly what FsStorage would have written.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type LadderSize,
  PAGE,
  ladderAddress,
} from '@digsite/shared/board/ladder';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { ladderPageKey } from '../src/boards/ladder.ts';
import { env } from '../src/env.ts';

type PageJob = { size: LadderSize; page: number; slots: number[] };
type InMsg = { boardId: string; jobs: PageJob[] };

function paintCell(
  ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>,
  dx: number,
  dy: number,
  s: number,
  slot: number,
): void {
  const hue = (slot * 137.508) % 360;
  ctx.fillStyle = `hsl(${hue}, 65%, 55%)`;
  ctx.fillRect(dx, dy, s, s);

  ctx.strokeStyle = `hsl(${hue}, 65%, 30%)`;
  ctx.lineWidth = Math.max(1, s * 0.12);
  ctx.beginPath();
  ctx.moveTo(dx, dy);
  ctx.lineTo(dx + s, dy + s);
  ctx.stroke();

  if (s === 128) {
    ctx.fillStyle = 'rgba(0,0,0,0.85)';
    ctx.font = `${Math.round(s * 0.2)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(slot), dx + s / 2, dy + s / 2);
  }
}

async function paintJob(boardId: string, job: PageJob): Promise<void> {
  const path = join(env.DATA_DIR, ladderPageKey(boardId, job.size, job.page));
  const canvas = createCanvas(PAGE, PAGE);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#222';
  ctx.fillRect(0, 0, PAGE, PAGE);
  if (existsSync(path)) {
    const img = await loadImage(readFileSync(path));
    ctx.drawImage(img, 0, 0);
  }

  for (const slot of job.slots) {
    const { x, y } = ladderAddress(slot, job.size);
    paintCell(ctx, x, y, job.size, slot);
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, canvas.encodeSync('png'));
}

declare const self: Worker;

self.onmessage = async (ev: MessageEvent<InMsg>) => {
  const { boardId, jobs } = ev.data;
  for (const job of jobs) {
    await paintJob(boardId, job);
  }
  postMessage({ done: jobs.length });
};
