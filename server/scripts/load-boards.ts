// docs/phases/5-hardening.md section 5 ("The cross-board load run"): 20
// boards of 500,000 synthetic images each (10,000,000 total), each with two
// sorts built and materialised, then 20 simulated viewers panning different
// boards at once for 5 minutes with LADDER_BUDGET_MB at the default.
// Results recorded in docs/measurements/phase-5.md.
//
// Three subcommands, run in order (each is idempotent/safe to re-run on its
// own — "build" resumes a partial board the same way synth.ts does; "load"
// only reads; "cleanup" deletes through the product's own board-delete
// route, which is the thing this run also wants to exercise at 10M-image
// scale):
//
//   bun run scripts/load-boards.ts build
//   PORT=8814 bun run scripts/load-boards.ts load [durationMs]
//   bun run scripts/load-boards.ts cleanup
//
// "build" and "cleanup" talk to Postgres/Storage directly (no server
// needed — same reasoning as synth.ts). "load" starts the real HTTP server
// IN-PROCESS (app.ts#createHttpServer, no `.listen()` wrapper script and no
// child process) rather than requiring an operator to start one separately
// the way measure-map.ts does: this run wants boards/ladder.ts's resident-
// page LRU and its eviction counter in the SAME process the viewers hit,
// and a metric read after the loop (`evictionCount()`, `residentBytes()`)
// only means anything if it is the process that actually served the
// requests. WORKER is never started — every board is already fully ranked
// and materialised by "build" before "load" runs, so there is nothing for
// a worker to do and none is needed.
//
// Safety (this task's brief): run under
//   systemd-run --user --scope -p MemoryMax=60G -p MemorySwapMax=0 -- \
//     bun run scripts/load-boards.ts <subcommand> ...
// "build" checks free disk before painting a single page and aborts rather
// than proceed if eager S=128 painting would cross 20% of free space
// (docs/phases/1-map.md's own fallback trigger, never needed there either
// — see docs/measurements/phase-1-map.md "What didn't work" item 6).
import { execFileSync } from 'node:child_process';
import type { Server } from 'node:http';
import { ZOOMS, type Zoom } from '@digsite/shared/board/grid';
import { LADDER, type LadderSize, PAGE } from '@digsite/shared/board/ladder';
import { type Sort, sortId as toSortId } from '@digsite/shared/board/sort';
import { createHttpServer } from '../src/app.ts';
import { residentBytes as coarseResidentBytes } from '../src/boards/coarse-cache.ts';
import {
  evictionCount,
  residentBytes as ladderResidentBytes,
} from '../src/boards/ladder.ts';
import { tileGrid } from '../src/boards/materialise.ts';
import { materialiseSort } from '../src/boards/materialise.ts';
import { forceRebuildRank } from '../src/boards/ranks.ts';
import { pool } from '../src/db/pool.ts';
import { env } from '../src/env.ts';
import { WorkerPool, growBoard, resolveBoard } from './synth.ts';

// Overridable only for a cheap smoke run of this script itself (verifying
// the build/load/cleanup plumbing end-to-end before committing to the real
// 10,000,000-image run) — docs/measurements/phase-5.md's real numbers are
// the default 20 x 500,000, never a smoke-run override.
const BOARD_COUNT = Number(process.env.LOAD_BOARD_COUNT ?? 20);
const IMAGES_PER_BOARD = Number(process.env.LOAD_IMAGES_PER_BOARD ?? 500_000);
const TOTAL_IMAGES = BOARD_COUNT * IMAGES_PER_BOARD;
const SORTS: Sort[] = [
  { key: 'uploaded_at', dir: 'desc' }, // the board's default sort
  { key: 'name', dir: 'asc' },
];
const MEMBER_EMAIL = 'member@example.test';
// This is a SIGN-IN, not a sign-up, so section 3's new minPasswordLength
// (auth.ts) never applies to it — it only has to match whatever password
// this pre-existing seeded account actually has. Confirmed against the live
// dev DB: this account was seeded before that change landed and still
// carries its original 'password1' (`bun run seed` never overwrites an
// existing user's password — see seed.ts). measure-map.ts's own
// MEMBER_PASSWORD is 'password1234' and would fail the same way against
// this same account; not touched here — out of this script's job, and
// section 3 is owned by another agent this phase.
const MEMBER_PASSWORD = 'password1';

function boardName(n: number): string {
  return `load-${n}`;
}

// -- disk check --------------------------------------------------------------
//
// node:fs.statfsSync returns garbage (negative bfree/bavail) on this
// machine's 24TB /mnt/Ghar filesystem under Bun — confirmed by hand before
// writing this: a 32-bit-signed-overflow-shaped bug, not a typo here. `df`
// itself is correct (this is also what the brief's own "check df -h first"
// instruction assumes), so shell out to it instead of trusting the syscall
// wrapper.
function freeBytes(path: string): number {
  const out = execFileSync('df', ['-k', '--output=avail', path], {
    encoding: 'utf8',
  });
  const lines = out.trim().split('\n');
  const kb = Number(lines[lines.length - 1]?.trim());
  if (!Number.isFinite(kb)) {
    throw new Error(`could not parse df output for ${path}: ${out}`);
  }
  return kb * 1024;
}

/** Every ladder page this run's eager painting will write, across every
 * board and every LADDER size — PNG-encoded pages are smaller than this
 * (solid-colour-ish synthetic cells compress well), so this over-estimates
 * on purpose: the brief's trigger is "would exceed", and a false alarm
 * costs one aborted run while a false pass risks the disk. */
function projectedLadderBytes(totalImages: number): number {
  let bytes = 0;
  for (const s of LADDER) {
    const perPageCount = (PAGE / s) * (PAGE / s);
    const pages = Math.ceil(totalImages / perPageCount);
    bytes += pages * PAGE * PAGE * 4; // decoded-size upper bound, not the PNG's
  }
  return bytes;
}

function checkDiskOrThrow(): void {
  const free = freeBytes(env.DATA_DIR);
  const projected = projectedLadderBytes(TOTAL_IMAGES);
  const twentyPercent = free * 0.2;
  console.log(
    `disk: ${(free / 1024 ** 3).toFixed(1)} GiB free at ${env.DATA_DIR}, ` +
      `projected eager ladder paint ${(projected / 1024 ** 3).toFixed(1)} GiB ` +
      `(20% of free = ${(twentyPercent / 1024 ** 3).toFixed(1)} GiB)`,
  );
  if (projected > twentyPercent) {
    throw new Error(
      `refusing to paint S=128 eagerly: projected ${(projected / 1024 ** 3).toFixed(1)} GiB would exceed 20% of the ${(free / 1024 ** 3).toFixed(1)} GiB free at ${env.DATA_DIR}. Stop here and report — see docs/phases/5-hardening.md section 5.`,
    );
  }
}

// -- build: create/grow 20 boards, then rank + materialise 2 sorts each -----
type BuildResult = {
  boardId: string;
  name: string;
  imageCount: number;
  rebuildMs: Record<string, number>;
  materialiseMs: Record<string, number>;
};

async function cmdBuild(): Promise<void> {
  checkDiskOrThrow();

  const member = await pool.query(`SELECT id FROM "user" WHERE email = $1`, [
    MEMBER_EMAIL,
  ]);
  if (member.rows.length === 0) {
    throw new Error(
      `user ${MEMBER_EMAIL} not found — run \`bun run seed\` against a running server first`,
    );
  }
  const memberId = member.rows[0].id as string;

  const wp = new WorkerPool(
    Math.max(1, Math.min(Number(process.env.SYNTH_WORKERS ?? 16), 32)),
  );
  const results: BuildResult[] = [];

  try {
    for (let n = 1; n <= BOARD_COUNT; n++) {
      const t0 = performance.now();
      const { boardId, imageCount: existingCount } = await resolveBoard(
        '',
        boardName(n),
      );
      console.log(
        `[${n}/${BOARD_COUNT}] board ${boardName(n)} (${boardId}): ` +
          `image_count=${existingCount}, target=${IMAGES_PER_BOARD}`,
      );

      await growBoard(
        wp,
        boardId,
        memberId,
        existingCount,
        IMAGES_PER_BOARD,
        (cursor, target) => {
          const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
          console.log(
            `  progress: ${cursor}/${target} images (${elapsed}s elapsed)`,
          );
        },
      );

      const rebuildMs: Record<string, number> = {};
      const materialiseMs: Record<string, number> = {};
      for (const sort of SORTS) {
        const sid = toSortId(sort);
        const rStart = performance.now();
        await forceRebuildRank(boardId, sort);
        rebuildMs[sid] = performance.now() - rStart;

        const mStart = performance.now();
        const { tiles } = await materialiseSort(boardId, sort);
        materialiseMs[sid] = performance.now() - mStart;
        console.log(
          `  ${sid}: rank ${rebuildMs[sid]?.toFixed(0)}ms, ` +
            `materialise ${materialiseMs[sid]?.toFixed(0)}ms (${tiles} tiles)`,
        );
      }

      results.push({
        boardId,
        name: boardName(n),
        imageCount: IMAGES_PER_BOARD,
        rebuildMs,
        materialiseMs,
      });
    }
  } finally {
    wp.terminate();
  }

  console.log(JSON.stringify({ step: 'build', results }, null, 2));
  await pool.end();
}

// -- load: 20 concurrent viewers, one board each, for durationMs ------------
type TileSample = { z: Zoom; wallMs: number; xCache: string };

async function signInMember(base: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ email: MEMBER_EMAIL, password: MEMBER_PASSWORD }),
  });
  if (res.status !== 200) {
    throw new Error(
      `sign-in as ${MEMBER_EMAIL} failed: ${res.status} ${await res.text()}`,
    );
  }
  const setCookie = res.headers.get('set-cookie');
  const cookie = setCookie?.split(';')[0] ?? '';
  if (!cookie) throw new Error('sign-in succeeded but carried no cookie');
  return cookie;
}

async function loadBoardsList(): Promise<
  { boardId: string; name: string; imageCount: number }[]
> {
  const { rows } = await pool.query(
    `SELECT id, name, image_count FROM boards WHERE name LIKE 'load-%' ORDER BY name`,
  );
  return rows.map((r) => ({
    boardId: r.id as string,
    name: r.name as string,
    imageCount: r.image_count as number,
  }));
}

async function viewerLoop(
  base: string,
  cookie: string,
  boardId: string,
  imageCount: number,
  sortIds: string[],
  deadline: number,
  samples: TileSample[],
): Promise<void> {
  while (Date.now() < deadline) {
    const z = ZOOMS[Math.floor(Math.random() * ZOOMS.length)] as Zoom;
    const sid = sortIds[Math.floor(Math.random() * sortIds.length)] as string;
    const { nx, ny } = tileGrid(imageCount, z);
    const x = Math.floor(Math.random() * nx);
    const y = Math.floor(Math.random() * ny);
    const start = performance.now();
    const res = await fetch(
      `${base}/boards/${boardId}/tiles/${sid}/${z}/${x}/${y}.png`,
      { headers: { cookie } },
    );
    await res.arrayBuffer();
    const wallMs = performance.now() - start;
    samples.push({ z, wallMs, xCache: res.headers.get('X-Cache') ?? 'none' });
  }
}

function percentile(vals: number[], p: number): number {
  if (vals.length === 0) return Number.NaN;
  const sorted = [...vals].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.floor((p / 100) * sorted.length),
  );
  return sorted[idx] as number;
}

async function cmdLoad(durationMs: number): Promise<void> {
  const boards = await loadBoardsList();
  if (boards.length < BOARD_COUNT) {
    throw new Error(
      `expected ${BOARD_COUNT} load-* boards, found ${boards.length} — run "build" first`,
    );
  }
  console.log(
    `load: ${boards.length} boards, ${durationMs}ms, LADDER_BUDGET_MB=${env.LADDER_BUDGET_MB}`,
  );

  const server: Server = createHttpServer();
  await new Promise<void>((resolve) => server.listen(env.PORT, resolve));
  const base = env.SERVER_ORIGIN;
  console.log(`server listening: ${base}`);

  const cookie = await signInMember(base);
  const sortIds = SORTS.map(toSortId);

  // RSS sampled every 5s for a peak; ladder evictions sampled every 60s for
  // a per-minute rate — .claude/rules/tile-cache-is-for-the-second-viewer.md
  // is the reason evictions matter here: a viewer's miss is fast only while
  // its board's pages stay resident, and 20 boards sharing one
  // LADDER_BUDGET_MB is exactly the contention that rule doesn't cover.
  let rssPeakBytes = 0;
  const rssTimer = setInterval(() => {
    rssPeakBytes = Math.max(rssPeakBytes, process.memoryUsage().rss);
  }, 5000);

  const evictionsPerMinute: number[] = [];
  let lastEvictions = evictionCount();
  const evictionTimer = setInterval(() => {
    const now = evictionCount();
    evictionsPerMinute.push(now - lastEvictions);
    lastEvictions = now;
  }, 60_000);

  const samples: TileSample[] = [];
  const deadline = Date.now() + durationMs;
  await Promise.all(
    boards
      .slice(0, BOARD_COUNT)
      .map((b) =>
        viewerLoop(
          base,
          cookie,
          b.boardId,
          b.imageCount,
          sortIds,
          deadline,
          samples,
        ),
      ),
  );

  clearInterval(rssTimer);
  clearInterval(evictionTimer);
  rssPeakBytes = Math.max(rssPeakBytes, process.memoryUsage().rss);

  await new Promise<void>((resolve) => server.close(() => resolve()));

  const byZoom: Record<
    string,
    { p50: number; p95: number; p99: number; n: number }
  > = {};
  for (const z of ZOOMS) {
    const vals = samples.filter((s) => s.z === z).map((s) => s.wallMs);
    byZoom[String(z)] = {
      p50: percentile(vals, 50),
      p95: percentile(vals, 95),
      p99: percentile(vals, 99),
      n: vals.length,
    };
  }

  const byCache: Record<
    string,
    { p50: number; p95: number; p99: number; n: number }
  > = {};
  for (const cache of new Set(samples.map((s) => s.xCache))) {
    const vals = samples.filter((s) => s.xCache === cache).map((s) => s.wallMs);
    byCache[cache] = {
      p50: percentile(vals, 50),
      p95: percentile(vals, 95),
      p99: percentile(vals, 99),
      n: vals.length,
    };
  }

  console.log(
    JSON.stringify(
      {
        step: 'load',
        durationMs,
        boards: boards.length,
        totalSamples: samples.length,
        byZoom,
        byCache,
        evictionsPerMinute,
        rssPeakBytes,
        rssPeakMB: Math.round(rssPeakBytes / 1024 / 1024),
        ladderResidentBytesEnd: ladderResidentBytes(),
        coarseResidentBytesEnd: coarseResidentBytes(),
      },
      null,
      2,
    ),
  );
  await pool.end();
}

// -- cleanup: delete every load-* board through the real HTTP route --------
async function cmdCleanup(): Promise<void> {
  const boards = await loadBoardsList();
  if (boards.length === 0) {
    console.log('no load-* boards found — nothing to clean up');
    await pool.end();
    return;
  }

  const server: Server = createHttpServer();
  await new Promise<void>((resolve) => server.listen(env.PORT, resolve));
  const base = env.SERVER_ORIGIN;
  const cookie = await signInMember(base);

  for (const b of boards) {
    const t0 = performance.now();
    const res = await fetch(`${base}/boards/${b.boardId}`, {
      method: 'DELETE',
      headers: { cookie, Origin: base },
    });
    const ms = performance.now() - t0;
    console.log(
      `delete ${b.name} (${b.boardId}): ${res.status} in ${ms.toFixed(0)}ms`,
    );
    if (res.status !== 200) {
      console.error(`  body: ${await res.text()}`);
    }
  }

  await new Promise<void>((resolve) => server.close(() => resolve()));

  const remaining = await loadBoardsList();
  console.log(
    JSON.stringify(
      {
        step: 'cleanup',
        deleted: boards.length - remaining.length,
        remaining: remaining.length,
      },
      null,
      2,
    ),
  );
  await pool.end();
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'build') {
    await cmdBuild();
  } else if (cmd === 'load') {
    const durationMs = Number(
      rest[0] ?? process.env.LOAD_DURATION_MS ?? 5 * 60 * 1000,
    );
    await cmdLoad(durationMs);
  } else if (cmd === 'cleanup') {
    await cmdCleanup();
  } else {
    console.error(
      'usage: bun run scripts/load-boards.ts <build|load|cleanup> [durationMs]',
    );
    process.exit(1);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error('load-boards failed:', err);
    process.exit(1);
  });
}
