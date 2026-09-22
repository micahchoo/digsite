// After a rank rebuild for (board, sort), compose every tile for z <= -3 and
// write it to disk, then record board_rank_state.materialised_at.
// tiles.ts#tileFor serves these directly once they exist and the state is
// not stale — docs/phases/1-map.md "Materialised coarse levels",
// .claude/rules/tile-cache-is-for-the-second-viewer.md (this is the "next
// lever" that rule names). Run by worker/jobs.ts#runMaterialiseJob, and
// directly by the manual `POST /boards/:id/sort/:sortId/rebuild` route.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  CELL,
  ZOOMS,
  type Zoom,
  cellPx,
  perTileSide,
  worldExtent,
} from '@digsite/shared/board/grid';
import { type Sort, sortId } from '@digsite/shared/board/sort';
import { pool } from '../db/pool.ts';
import { env } from '../env.ts';
import { preloadPages } from './ladder.ts';
import { slotsForTile } from './ranks.ts';
import { composeTile, materialisedTilePath, pendingSlotsFor } from './tiles.ts';

const MATERIALISE_ZOOMS = ZOOMS.filter((z) => z <= -3);

function tileGrid(count: number, z: Zoom): { nx: number; ny: number } {
  const [, , w, h] = worldExtent(count);
  const side = perTileSide(z) * CELL;
  return {
    nx: Math.max(1, Math.ceil(w / side)),
    ny: Math.max(1, Math.ceil(h / side)),
  };
}

export async function materialiseSort(
  boardId: string,
  sort: Sort,
): Promise<{ tiles: number; ms: number }> {
  const start = performance.now();
  const sid = sortId(sort);

  const { rows } = await pool.query(
    'SELECT image_count FROM boards WHERE id = $1',
    [boardId],
  );
  const count = rows[0]?.image_count ?? 0;

  const dir = `${env.DATA_DIR}/boards/${boardId}/tiles/${sid}`;
  rmSync(dir, { recursive: true, force: true }); // a stale rebuild deletes the directory before composing
  mkdirSync(dir, { recursive: true });

  if (count > 0) {
    // z=-3 reads S=32 pages, z=-4 and z=-5 read S=8 (shared/board/ladder.ts
    // sizeFor) — load both once, up front, so composeTile's getPage calls
    // hit the resident cache instead of the disk.
    await preloadPages(boardId, 32, count);
    await preloadPages(boardId, 8, count);
  }

  const jobs: { z: Zoom; x: number; y: number }[] = [];
  for (const z of MATERIALISE_ZOOMS) {
    const { nx, ny } = tileGrid(count, z);
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) jobs.push({ z, x, y });
    }
  }

  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      const job = jobs[i];
      if (!job) return;
      const slots = await slotsForTile(boardId, sort, job.z, job.x, job.y);
      const pendingSlots = await pendingSlotsFor(boardId, slots);
      const png = await composeTile(
        boardId,
        cellPx(job.z),
        slots,
        pendingSlots,
      );
      const path = materialisedTilePath(boardId, sid, job.z, job.x, job.y);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, png);
    }
  }

  const concurrency = Math.max(1, env.WORKER_CONCURRENCY);
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  await pool.query(
    `INSERT INTO board_rank_state (board_id, sort_id, built_at, stale, materialised_at)
     VALUES ($1, $2, now(), false, now())
     ON CONFLICT (board_id, sort_id) DO UPDATE SET materialised_at = now()`,
    [boardId, sid],
  );

  return { tiles: jobs.length, ms: performance.now() - start };
}
