// After a rank rebuild for (board, sort), compose every tile for z <= -3 and
// write it to disk, then record board_rank_state.materialised_at.
// tiles.ts#tileFor serves these directly once they exist and the state is
// not stale — docs/phases/1-map.md "Materialised coarse levels",
// .claude/rules/tile-cache-is-for-the-second-viewer.md (this is the "next
// lever" that rule names). Run by worker/jobs.ts#runMaterialiseJob, and
// directly by the manual `POST /boards/:id/sort/:sortId/rebuild` route.
//
// docs/measurements/phase-1-map.md "Row 4": the original per-tile GATHER
// (slotsForTile query + compose + encode, once per tile, WORKER_CONCURRENCY
// of them "in parallel" on the one JS thread) took 277s on the 1,000,000-
// image board — compose is CPU work, so concurrency on one thread never
// helped it, and z=-3 alone touches every S=32 page regardless of tile
// order. This is a SCATTER instead: one query for the whole sort's ranks,
// every z<=-3 tile canvas allocated up front, then one pass over the
// ladder's own pages — each page decoded once and drawn into however many
// tiles/zooms its slots land in — and PNG encoding (the actual CPU cost)
// moved onto a pool of real OS threads. The ladder residency cache
// (ladder.ts) is not touched here on purpose: this reads pages directly off
// disk so materialising never evicts what a live viewer's pan has resident.
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import {
  CELL,
  TILE,
  ZOOMS,
  type Zoom,
  cellOf,
  cellPx,
  perTileSide,
  worldExtent,
} from '@digsite/shared/board/grid';
import {
  type LadderSize,
  PAGE,
  ladderAddress,
  perPage,
  sizeFor,
} from '@digsite/shared/board/ladder';
import { type Sort, sortId } from '@digsite/shared/board/sort';
import { type Canvas, Image, createCanvas } from '@napi-rs/canvas';
import { pool } from '../db/pool.ts';
import { env } from '../env.ts';
import { setResidentSort } from './coarse-cache.ts';
import { ladderPagePath } from './ladder.ts';
import { PENDING_COLOR, materialisedTilePath } from './tiles.ts';

const MATERIALISE_ZOOMS = ZOOMS.filter((z) => z <= -3);

// Exported for the pixel-identity test (materialise.test.ts) and
// measure-map.ts, which both need the same grid math without duplicating it.
export function tileGrid(count: number, z: Zoom): { nx: number; ny: number } {
  const [, , w, h] = worldExtent(count);
  const side = perTileSide(z) * CELL;
  return {
    nx: Math.max(1, Math.ceil(w / side)),
    ny: Math.max(1, Math.ceil(h / side)),
  };
}

type TileEntry = {
  z: Zoom;
  x: number;
  y: number;
  path: string;
  canvas: Canvas;
  ctx: ReturnType<Canvas['getContext']>;
};

function tileKey(z: Zoom, x: number, y: number): string {
  return `${z}:${x}:${y}`;
}

/** Every z<=-3 tile canvas for one sort, allocated up front (RGBA, before
 * PNG encoding). Throws rather than allocate past MATERIALISE_BUDGET_MB —
 * docs/phases/1-map.md's "fail loudly" — instead of an OOM partway through
 * a run that already deleted the previous, working set of files. */
function allocateTiles(
  boardId: string,
  sid: string,
  count: number,
): Map<string, TileEntry> {
  const grids = new Map<Zoom, { nx: number; ny: number }>();
  let totalTiles = 0;
  for (const z of MATERIALISE_ZOOMS) {
    const grid = tileGrid(count, z);
    grids.set(z, grid);
    totalTiles += grid.nx * grid.ny;
  }

  const bytes = totalTiles * TILE * TILE * 4;
  const budgetBytes = env.MATERIALISE_BUDGET_MB * 1024 * 1024;
  if (bytes > budgetBytes) {
    throw new Error(
      `materialise: ${totalTiles} tiles at ${TILE}x${TILE} RGBA need ` +
        `${(bytes / 1024 / 1024).toFixed(0)} MB, over MATERIALISE_BUDGET_MB=${env.MATERIALISE_BUDGET_MB} MB`,
    );
  }

  const tiles = new Map<string, TileEntry>();
  for (const z of MATERIALISE_ZOOMS) {
    const { nx, ny } = grids.get(z) as { nx: number; ny: number };
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const canvas = createCanvas(TILE, TILE);
        tiles.set(tileKey(z, x, y), {
          z,
          x,
          y,
          path: materialisedTilePath(boardId, sid, z, x, y),
          canvas,
          ctx: canvas.getContext('2d'),
        });
      }
    }
  }
  return tiles;
}

/** Reads one ladder page straight off disk — never through ladder.ts's
 * resident LRU. That cache is budgeted and shared with live viewers'
 * panning; a materialise pass touching every page of a size would evict
 * whatever a concurrent viewer had resident for no benefit (this pass never
 * revisits a page, so caching it here would only cost memory).
 *
 * Paints INTO a canvas the caller owns and reuses across every page of one
 * size, rather than allocating a fresh one per page. `@napi-rs/canvas`'s
 * native pixel buffers are not visible to V8's GC heuristics (no external
 * memory is registered), so a fresh `createCanvas` every iteration of a
 * ~4,000-page loop never gets collected in time — measured: 5,216 tile
 * canvases held steady at 800 MB, but allocating one fresh 512x512 source
 * canvas per page on top of that reached the kernel OOM killer within
 * 6 seconds and 30 GB on the 1,000,000-image board, confirmed in isolation
 * with a synthetic reproduction (no DB, no real files) that hit the same
 * wall inside 2 seconds. Reusing one source canvas per ladder size (this
 * function's `dst` parameter) keeps the whole pass's growth linear and
 * bounded — the same synthetic reproduction finished at 5.5 GB instead of
 * OOMing. */
async function paintPageDirect(
  boardId: string,
  s: LadderSize,
  page: number,
  dstCtx: ReturnType<Canvas['getContext']>,
  img: Image, // reused across every page too, same reason as the canvas
): Promise<void> {
  const path = ladderPagePath(boardId, s, page);
  dstCtx.fillStyle = '#222';
  dstCtx.fillRect(0, 0, PAGE, PAGE);
  if (existsSync(path)) {
    img.src = readFileSync(path);
    await img.decode();
    dstCtx.drawImage(img, 0, 0);
  }
}

/** Every zoom that reads ladder size `s`, per shared/board/ladder.ts's
 * `sizeFor(cellPx(z))` — at today's LADDER sizes that's z=-3 -> S=32,
 * z=-4/-5 -> S=8, but this derives it rather than hardcoding the split. */
function zoomsForSize(s: LadderSize): Zoom[] {
  return MATERIALISE_ZOOMS.filter((z) => sizeFor(cellPx(z)) === s);
}

function sizesNeeded(): LadderSize[] {
  const sizes = new Set<LadderSize>();
  for (const z of MATERIALISE_ZOOMS) sizes.add(sizeFor(cellPx(z)));
  return [...sizes];
}

/** Scatters one ladder size's pages into every tile that needs them: decode
 * a page once, then for each of its slots draw into the right cell of the
 * right tile at every zoom this size serves. */
async function scatterSize(
  boardId: string,
  s: LadderSize,
  count: number,
  rankOfSlot: Int32Array,
  pendingSlots: Uint8Array,
  tiles: Map<string, TileEntry>,
): Promise<void> {
  const zooms = zoomsForSize(s);
  if (zooms.length === 0) return;
  const capacity = perPage(s);
  const maxPage = Math.floor((count - 1) / capacity);

  // One page canvas and one Image, reused for every page of this size —
  // see paintPageDirect's header comment for why a fresh one per iteration
  // OOMs the process well before finishing.
  const pageCanvas = createCanvas(PAGE, PAGE);
  const pageCtx = pageCanvas.getContext('2d');
  const img = new Image();

  for (let page = 0; page <= maxPage; page++) {
    await paintPageDirect(boardId, s, page, pageCtx, img);
    const base = page * capacity;
    const limit = Math.min(capacity, count - base);

    for (let i = 0; i < limit; i++) {
      const slot = base + i;
      const rank = rankOfSlot[slot];
      if (rank === undefined || rank < 0) continue; // no rank row for this slot

      const { x: sx, y: sy } = ladderAddress(slot, s);
      const { col, row } = cellOf(rank);
      const pending = pendingSlots[slot] === 1;

      for (const z of zooms) {
        const side = perTileSide(z);
        const tx = Math.floor(col / side);
        const ty = Math.floor(row / side);
        const entry = tiles.get(tileKey(z, tx, ty));
        if (!entry) continue; // past the board's own grid — shouldn't happen
        const px = cellPx(z);
        const dx = (col % side) * px;
        const dy = (row % side) * px;

        if (pending) {
          entry.ctx.fillStyle = PENDING_COLOR;
          entry.ctx.fillRect(dx, dy, px, px);
        } else {
          entry.ctx.drawImage(pageCanvas, sx, sy, s, s, dx, dy, px, px);
        }
      }
    }
  }
}

/** Round-robins finished tile canvases across a pool of real OS threads for
 * PNG encoding — the CPU cost docs/measurements/phase-1-map.md's Row 4
 * traced the 277s to. `os.cpus().length - 2` leaves two cores for the DB
 * client and the rest of the process. */
class EncodePool {
  private workers: Worker[];

  constructor(count: number) {
    const url = new URL('../worker/tile-encode-worker.ts', import.meta.url);
    this.workers = Array.from({ length: count }, () => new Worker(url));
  }

  async run(tiles: TileEntry[]): Promise<void> {
    let next = 0;
    await Promise.all(
      this.workers.map(
        (w) =>
          new Promise<void>((resolve, reject) => {
            const onError = (e: ErrorEvent) => {
              w.removeEventListener('message', onMessage);
              w.removeEventListener('error', onError);
              reject(e.error ?? e);
            };
            const onMessage = () => {
              const entry = tiles[next++];
              if (!entry) {
                w.removeEventListener('message', onMessage);
                w.removeEventListener('error', onError);
                resolve();
                return;
              }
              const buf = entry.canvas.data();
              const rgba = buf.buffer.slice(
                buf.byteOffset,
                buf.byteOffset + buf.byteLength,
              ) as ArrayBuffer; // Buffer.buffer's type admits SharedArrayBuffer; ours is never shared
              w.postMessage(
                {
                  path: entry.path,
                  width: TILE,
                  height: TILE,
                  rgba,
                },
                [rgba],
              );
            };
            w.addEventListener('message', onMessage);
            w.addEventListener('error', onError);
            onMessage(); // prime the first job
          }),
      ),
    );
  }

  terminate(): void {
    for (const w of this.workers) w.terminate();
  }
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

  const tiles = allocateTiles(boardId, sid, count);

  if (count > 0) {
    // One query for the whole sort, not one per tile — slot -> rank as a
    // flat Int32Array (~4 MB at 1,000,000 images) so the scatter loop below
    // never touches the database again.
    const rankOfSlot = new Int32Array(count).fill(-1);
    const { rows: rankRows } = await pool.query(
      'SELECT slot, rank FROM board_ranks WHERE board_id = $1 AND sort_id = $2',
      [boardId, sid],
    );
    for (const r of rankRows) rankOfSlot[r.slot as number] = r.rank as number;

    const pendingSlots = new Uint8Array(count);
    const { rows: pendingRows } = await pool.query(
      `SELECT slot FROM images WHERE board_id = $1 AND status = 'pending'`,
      [boardId],
    );
    for (const r of pendingRows) pendingSlots[r.slot as number] = 1;

    for (const s of sizesNeeded()) {
      await scatterSize(boardId, s, count, rankOfSlot, pendingSlots, tiles);
    }
  }

  const entries = [...tiles.values()];

  // Never more workers than tiles — a small board (a test, a fresh board)
  // shouldn't pay to boot dozens of OS threads for a few hundred PNGs.
  const concurrency = Math.max(
    1,
    Math.min(os.cpus().length - 2, entries.length),
  );
  const pool_ = new EncodePool(concurrency);
  try {
    await pool_.run(entries);
  } finally {
    pool_.terminate();
  }

  await pool.query(
    `INSERT INTO board_rank_state (board_id, sort_id, built_at, stale, materialised_at)
     VALUES ($1, $2, now(), false, now())
     ON CONFLICT (board_id, sort_id) DO UPDATE SET materialised_at = now()`,
    [boardId, sid],
  );

  // The tile route's first request after this never has to re-read disk:
  // hand the buffers we just wrote straight to the resident cache. A sort
  // bigger than COARSE_BUDGET_MB is declined (returns false) and falls back
  // to per-tile disk reads, same as a cold board after a restart.
  const residentTiles = new Map<string, Buffer>();
  for (const entry of entries) {
    residentTiles.set(`${entry.z}/${entry.x}-${entry.y}`, entry.canvas.data());
  }
  setResidentSort(boardId, sid, residentTiles);

  return { tiles: entries.length, ms: performance.now() - start };
}
