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
import { type Canvas, createCanvas } from '@napi-rs/canvas';
import { pool } from '../db/pool.ts';
import { env } from '../env.ts';
import { deletePrefix, storageFromEnv } from '../storage/index.ts';
import { Semaphore } from '../util/semaphore.ts';
import { setResidentSort } from './coarse-cache.ts';
import { publish } from './invalidation.ts';
import { decodePage, ladderPageKey } from './ladder.ts';
import { coarseTilesPrefix } from './paths.ts';
import { rankOrder } from './ranks.ts';
import { PENDING_COLOR, materialisedTileKey } from './tiles.ts';

const MATERIALISE_ZOOMS = ZOOMS.filter((z) => z <= -3);

// docs/measurements/phase-5.md "After the leftovers", problem 1, lead
// review round 2's site audit: `allocateTiles` below creates its whole
// destination-tile batch (5,216 canvases at 1,000,000 images) fresh on
// EVERY `materialiseSort` call, and — unlike the worker-thread encode
// pool's canvases (tile-encode-worker.ts), which are reclaimed whole when
// `EncodePool.terminate()` tears down the thread that made them — these
// live on the MAIN thread and are simply let go out of scope once their
// PNG bytes are extracted, so every rebuild permanently leaks its whole
// batch. A board rebuilt repeatedly (an active board, or this repo's own
// test/measurement history) compounds this over the process's lifetime.
// Reused across calls via an uncapped free list, same shape as ladder.ts
// and tiles.ts: `allocateTiles` draws from it before ever calling
// `createCanvas`, and `materialiseSort` returns every entry's canvas here
// once its PNG has been encoded (see its own `finally`).
const tileCanvasPool: Canvas[] = [];

function acquireMaterialiseTileCanvas(): Canvas {
  return tileCanvasPool.pop() ?? createCanvas(TILE, TILE);
}

function releaseMaterialiseTileCanvas(canvas: Canvas): void {
  tileCanvasPool.push(canvas);
}

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
  key: string;
  canvas: Canvas;
  ctx: ReturnType<Canvas['getContext']>;
  // Set by EncodePool.run() once the worker pool has PNG-encoded this
  // entry's pixels — the bytes actually written through Storage, and the
  // same bytes installed resident below. `entry.canvas.data()` is raw
  // RGBA, never this; storing that in the resident cache under a key
  // served as `Content-Type: image/png` was this file's pre-phase-4 bug
  // (the route's own test only ever asserted `cache === 'resident'`, never
  // decoded the bytes — see materialise.test.ts).
  png?: Buffer;
};

function tileKey(z: Zoom, x: number, y: number): string {
  return `${z}:${x}:${y}`;
}

/** MATERIALISE_BUDGET_MB's enforcement, docs/phases/5-hardening.md section
 * 5: before this, `allocateTiles`'s preflight arithmetic was the WHOLE
 * budget — it covered the tile RGBA canvases and nothing else, and
 * docs/measurements/phase-1-map.md's own "after" section says so explicitly
 * ("does not, and structurally cannot being a pre-flight arithmetic check,
 * catch the per-page native leak"). This is a live counter instead of a
 * static formula, so it can cover the two things a formula alone can't
 * honestly claim to bound: the reused decoded-page canvas (bounded and
 * small, but real) and the PNG buffers sitting between "encoded" and
 * "written through Storage" (NOT bounded on their own — `EncodePool.run`
 * pushes every `storage.put` onto one unawaited array, so a slow adapter
 * — S3, a loaded disk — falling behind a fast encode pool would otherwise
 * let that queue of Buffers grow without limit). `reserve` throws the
 * moment a request would cross the budget, before the allocation happens —
 * "refusing loudly", never an OOM found out about after the fact. */
class MaterialiseBudget {
  private used = 0;
  constructor(private readonly limitBytes: number) {}

  reserve(bytes: number, what: string): void {
    if (this.used + bytes > this.limitBytes) {
      throw new Error(
        `materialise: budget exceeded reserving ${what} (${(bytes / 1024 / 1024).toFixed(1)} MB ` +
          `would bring usage to ${((this.used + bytes) / 1024 / 1024).toFixed(1)} MB, ` +
          `over MATERIALISE_BUDGET_MB=${(this.limitBytes / 1024 / 1024).toFixed(0)} MB)`,
      );
    }
    this.used += bytes;
  }

  release(bytes: number): void {
    this.used -= bytes;
  }

  get usedBytes(): number {
    return this.used;
  }
}

/** Every z<=-3 tile canvas for one sort, allocated up front (RGBA, before
 * PNG encoding), reserved against `budget` as one lump sum before any
 * canvas is created — docs/phases/1-map.md's "fail loudly" — instead of an
 * OOM partway through a run that already deleted the previous, working set
 * of files. */
function allocateTiles(
  boardId: string,
  sid: string,
  count: number,
  budget: MaterialiseBudget,
): Map<string, TileEntry> {
  const grids = new Map<Zoom, { nx: number; ny: number }>();
  let totalTiles = 0;
  for (const z of MATERIALISE_ZOOMS) {
    const grid = tileGrid(count, z);
    grids.set(z, grid);
    totalTiles += grid.nx * grid.ny;
  }

  budget.reserve(totalTiles * TILE * TILE * 4, `${totalTiles} tile canvases`);

  const tiles = new Map<string, TileEntry>();
  for (const z of MATERIALISE_ZOOMS) {
    const { nx, ny } = grids.get(z) as { nx: number; ny: number };
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const canvas = acquireMaterialiseTileCanvas();
        const ctx = canvas.getContext('2d');
        // A reused canvas can carry a PREVIOUS pass's pixels — the scatter
        // below only draws cells that have a real slot (ranks.ts#slotsForTile's
        // "out of range" convention, same as tiles.ts#composeTile), so a
        // board whose grid has trailing empty cells needs those genuinely
        // blank, not whatever this canvas last held.
        ctx.clearRect(0, 0, TILE, TILE);
        tiles.set(tileKey(z, x, y), {
          z,
          x,
          y,
          key: materialisedTileKey(boardId, sid, z, x, y),
          canvas,
          ctx,
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
): Promise<void> {
  const key = ladderPageKey(boardId, s, page);
  dstCtx.fillStyle = '#222';
  dstCtx.fillRect(0, 0, PAGE, PAGE);
  const bytes = await storageFromEnv().get(key);
  // ladder.ts#decodePage: the canvas library cannot read every page it wrote.
  if (bytes) dstCtx.putImageData(await decodePage(bytes), 0, 0);
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
  budget: MaterialiseBudget,
): Promise<void> {
  const zooms = zoomsForSize(s);
  if (zooms.length === 0) return;
  const capacity = perPage(s);
  const maxPage = Math.floor((count - 1) / capacity);

  // One page canvas, reused for every page of this size —
  // see paintPageDirect's header comment for why a fresh one per iteration
  // OOMs the process well before finishing. Reserved/released around the
  // whole size's pass rather than per page: the canvas is the same
  // allocation reused PAGE*PAGE*4 bytes' worth every iteration, never
  // growing, so one reservation for the pass is the honest accounting (a
  // per-page reserve/release pair would just add churn for no more
  // precision).
  const pageBytes = PAGE * PAGE * 4;
  budget.reserve(pageBytes, `decoded page (size ${s})`);
  try {
    const pageCanvas = createCanvas(PAGE, PAGE);

    for (let page = 0; page <= maxPage; page++) {
      // In @napi-rs/canvas 0.1.100, repeated decoded-Image draws into a
      // reused destination canvas retain native memory. Reset the reusable
      // surface between pages; fillRect in paintPageDirect resets pixels
      // but did not keep RSS flat in the page-churn reproduction.
      pageCanvas.width = PAGE;
      pageCanvas.height = PAGE;
      const pageCtx = pageCanvas.getContext('2d');
      await paintPageDirect(boardId, s, page, pageCtx);
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
  } finally {
    budget.release(pageBytes);
  }
}

/** Round-robins finished tile canvases across a pool of real OS threads for
 * PNG encoding — the CPU cost docs/measurements/phase-1-map.md's Row 4
 * traced the 277s to. `env.MATERIALISE_ENCODERS` threads, each a whole JS
 * heap: 30 idle threads measured +254 MB, and a machine's core count is no
 * guide to the memory it can spare (the 4 GB soak, 2026-09-23).
 *
 * The worker (tile-encode-worker.ts) does ONLY the encode and hands the PNG
 * back; this pool writes it through Storage on the main thread. Before
 * phase 4 the worker wrote straight to disk — a worker thread doing its own
 * S3 PUT would mean constructing (and authenticating) an S3Client per
 * thread for no benefit, so the I/O moved here, onto the one Storage the
 * rest of the process already shares. */
class EncodePool {
  private workers: Worker[];

  constructor(count: number) {
    const url = new URL('../worker/tile-encode-worker.ts', import.meta.url);
    this.workers = Array.from({ length: count }, () => new Worker(url));
  }

  async run(tiles: TileEntry[], budget: MaterialiseBudget): Promise<void> {
    const storage = storageFromEnv();
    const puts: Promise<void>[] = [];
    let next = 0;
    let failure: unknown;

    const runWorker = (w: Worker) =>
      new Promise<void>((resolve, reject) => {
        let current: TileEntry | undefined;

        const onError = (e: ErrorEvent) => {
          w.removeEventListener('message', onMessage);
          w.removeEventListener('error', onError);
          reject(e.error ?? e);
        };

        const dispatchNext = () => {
          if (failure !== undefined) {
            // Another worker's budget.reserve already refused — stop handing
            // out new encode jobs rather than let this worker keep going
            // toward a budget that's already refused someone else.
            w.removeEventListener('message', onMessage);
            w.removeEventListener('error', onError);
            resolve();
            return;
          }
          const entry = tiles[next++];
          current = entry;
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
          w.postMessage({ width: TILE, height: TILE, rgba }, [rgba]);
        };

        const onMessage = (ev: MessageEvent<{ png: ArrayBuffer }>) => {
          const entry = current;
          if (entry) {
            const png = Buffer.from(ev.data.png);
            entry.png = png;
            // The PNG buffer counts against the budget from the moment it
            // exists until `storage.put` has actually written it — see this
            // class's header comment: an adapter slower than the encode
            // pool would otherwise let this queue of Buffers grow
            // unbounded, since every `put` is fired without waiting for the
            // previous one.
            try {
              budget.reserve(png.byteLength, 'pending PNG buffer');
            } catch (err) {
              failure = err;
              w.removeEventListener('message', onMessage);
              w.removeEventListener('error', onError);
              reject(err);
              return;
            }
            puts.push(
              storage
                .put(entry.key, png, 'image/png')
                .finally(() => budget.release(png.byteLength)),
            );
          }
          dispatchNext();
        };

        w.addEventListener('message', onMessage);
        w.addEventListener('error', onError);
        dispatchNext(); // prime the first job
      });

    try {
      await Promise.all(this.workers.map(runWorker));
    } finally {
      // Whether every worker resolved or one rejected on a budget refusal,
      // wait out whichever `put`s are already in flight — an orphaned PUT
      // racing the next materialise pass for this board is worse than the
      // extra wait.
      await Promise.allSettled(puts);
    }
  }

  terminate(): void {
    for (const w of this.workers) w.terminate();
  }
}

// One materialise at a time per process. MATERIALISE_BUDGET_MB and the
// encode threads are sized for ONE run; the worker runs several units at
// once, and four concurrent materialises after a restart OOM-killed a
// worker under a 4 GB cap within two seconds (the soak, 2026-09-23).
const oneAtATime = new Semaphore(1);

export function materialiseSort(
  boardId: string,
  sort: Sort,
): Promise<{ tiles: number; ms: number }> {
  return oneAtATime.run(() => materialiseSortNow(boardId, sort));
}

async function materialiseSortNow(
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

  // A stale rebuild clears the previous run's files before composing, so a
  // board that shrank doesn't leave orphaned extra tiles around forever.
  // `Storage.list` (docs/phases/5-hardening.md section 5) made this
  // adapter-agnostic — every tile within the NEW grid is fully overwritten
  // below regardless (the scatter draws every cell of every allocated
  // tile), so correctness never depended on this running; it is disk (or
  // bucket) hygiene, not a precondition of the compose below.
  await deletePrefix(storageFromEnv(), coarseTilesPrefix(boardId, sid));
  // Reclaim pre-versioned coarse tiles after the compact-grid upgrade.
  // Originals and slot-addressed ladder pages live under separate prefixes.
  await deletePrefix(storageFromEnv(), `boards/${boardId}/tiles/${sid}/`);

  const budget = new MaterialiseBudget(env.MATERIALISE_BUDGET_MB * 1024 * 1024);
  const tiles = allocateTiles(boardId, sid, count, budget);

  if (count > 0) {
    // The sort's whole order, already a flat slot -> rank Int32Array
    // (ranks.ts#rankOrder), so the scatter loop below never touches the
    // database again. A slot past its end was uploaded after the build.
    const { rankOfSlot } = await rankOrder(boardId, sort);

    const pendingSlots = new Uint8Array(count);
    const { rows: pendingRows } = await pool.query(
      `SELECT slot FROM images WHERE board_id = $1 AND status = 'pending'`,
      [boardId],
    );
    for (const r of pendingRows) pendingSlots[r.slot as number] = 1;

    for (const s of sizesNeeded()) {
      await scatterSize(
        boardId,
        s,
        count,
        rankOfSlot,
        pendingSlots,
        tiles,
        budget,
      );
    }
  }

  const entries = [...tiles.values()];

  // Never more workers than tiles — a small board (a test, a fresh board)
  // shouldn't pay to boot dozens of OS threads for a few hundred PNGs.
  const concurrency = Math.max(
    1,
    Math.min(env.MATERIALISE_ENCODERS, entries.length),
  );
  const pool_ = new EncodePool(concurrency);
  try {
    await pool_.run(entries, budget);
  } finally {
    pool_.terminate();
    // Every entry's canvas goes back to the pool regardless of success or
    // failure — `EncodePool.run` reads pixels via `entry.canvas.data()`
    // (its own dispatchNext) before this point, so by the time we get here
    // nothing still needs these.
    for (const entry of entries) releaseMaterialiseTileCanvas(entry.canvas);
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
    if (!entry.png)
      throw new Error(
        'materialise: tile encoded with no png (unreachable — EncodePool.run resolves only once every entry received one)',
      );
    residentTiles.set(`${entry.z}/${entry.x}-${entry.y}`, entry.png);
  }
  setResidentSort(boardId, sid, residentTiles);
  // Installed here; any other process may hold the previous files.
  await publish({ kind: 'materialised', boardId });

  return { tiles: entries.length, ms: performance.now() - start };
}
