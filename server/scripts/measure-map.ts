// docs/phases/1-map.md section 4 ("The scale run") and the target table at
// the top of that file. Drives the REAL HTTP routes (server/src/boards/
// routes.ts) against a running server as the seed's `member` user — see
// server/src/seed.ts for the fixture and server/scripts/synth.ts for how
// the 1,000,000-image board this measures was built.
//
// Five subcommands, run separately (the server has to be restarted between
// the two LADDER_BUDGET_MB values, which this script does not do — see
// ../../../prototype/board/server/run-condition.sh for the pattern this
// follows: an operator starts the server with the right env, waits for it,
// then invokes the relevant subcommand):
//
//   bun run scripts/measure-map.ts rank <boardId>
//   bun run scripts/measure-map.ts tiles <boardId> <budgetLabel>
//   bun run scripts/measure-map.ts materialise <boardId>
//   bun run scripts/measure-map.ts coarse <boardId>
//   bun run scripts/measure-map.ts viewer <boardId> <webOrigin>
//
// Every subcommand prints one JSON object to stdout.
import { existsSync } from 'node:fs';
import {
  CELL,
  ZOOMS,
  type Zoom,
  cellPx,
  perTileSide,
  worldExtent,
} from '@digsite/shared/board/grid';
import { chromium } from 'playwright';
import { pool } from '../src/db/pool.ts';
import { env } from '../src/env.ts';

const SERVER = env.SERVER_ORIGIN;
const MEMBER_EMAIL = 'member@example.test';
// A sign-in, not a sign-up — section 3's minPasswordLength (auth.ts) never
// applies here, only whatever password the pre-existing seeded account
// actually carries. Confirmed against the live dev DB (docs/phases/
// 5-hardening.md section 5's load run hit this exact mismatch first): this
// account predates that change and `bun run seed` never rewrites an
// existing user's password, so it is still 'password1', not seed.ts's
// current default for a NEW user.
// A database seeded by src/seed.ts today uses password1234: overridable.
const MEMBER_PASSWORD = process.env.MEASURE_PASSWORD ?? 'password1';

const SORTS = ['uploaded_at.desc', 'name.asc', 'p.number.year.asc'] as const;
const TILE_SORT = 'uploaded_at.desc'; // the sort tiles/materialise/coarse measure

// -- a tiny cookie-jar session, same shape as server/src/seed.ts and
// e2e/src/session.ts (a plain fetch, never Playwright's `request` module —
// see e2e/src/session.ts's header comment for why that combination hangs
// under bun 1.3.14). -------------------------------------------------------
class Session {
  cookie = '';
  private async raw(
    method: string,
    path: string,
    init: { json?: unknown } = {},
  ): Promise<{ status: number; json: unknown }> {
    const headers: Record<string, string> = { Origin: SERVER };
    if (this.cookie) headers.cookie = this.cookie;
    let body: string | undefined;
    if (init.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(init.json);
    }
    const res = await fetch(`${SERVER}${path}`, { method, headers, body });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0] ?? '';
    const text = await res.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
    }
    return { status: res.status, json };
  }
  get(path: string) {
    return this.raw('GET', path);
  }
  post(path: string, json?: unknown) {
    return this.raw('POST', path, { json });
  }
  async getRaw(path: string): Promise<Response> {
    const headers: Record<string, string> = { Origin: SERVER };
    if (this.cookie) headers.cookie = this.cookie;
    return fetch(`${SERVER}${path}`, { headers });
  }
}

async function signInMember(): Promise<Session> {
  const s = new Session();
  const inn = await s.post('/api/auth/sign-in/email', {
    email: MEMBER_EMAIL,
    password: MEMBER_PASSWORD,
  });
  if (inn.status !== 200) {
    throw new Error(
      `sign-in as ${MEMBER_EMAIL} failed: ${inn.status} ${JSON.stringify(inn.json)} — run \`bun run seed\` against a running server first`,
    );
  }
  return s;
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
function median(vals: number[]): number {
  return percentile(vals, 50);
}

/** Same grid math as boards/materialise.ts#tileGrid, for every zoom (that
 * one only covers z <= -3). */
function tileGrid(count: number, z: Zoom): { nx: number; ny: number } {
  const [, , w, h] = worldExtent(count);
  const side = perTileSide(z) * CELL;
  return {
    nx: Math.max(1, Math.ceil(w / side)),
    ny: Math.max(1, Math.ceil(h / side)),
  };
}

function randomTiles(
  count: number,
  zooms: readonly Zoom[],
  perZoom: number,
): { z: Zoom; x: number; y: number }[] {
  const out: { z: Zoom; x: number; y: number }[] = [];
  for (const z of zooms) {
    const { nx, ny } = tileGrid(count, z);
    // Sampled WITHOUT repeats within a zoom: at a coarse zoom (z=-5 is only
    // 16x16=256 tiles) drawing 500 with replacement guarantees intra-pass
    // repeats, which would silently turn "500 random tiles" into a mix of
    // genuine composes and same-run composed-tile-cache hits. Capped at the
    // zoom's actual tile count when that's under `perZoom`.
    const target = Math.min(perZoom, nx * ny);
    const seen = new Set<string>();
    while (seen.size < target) {
      const x = Math.floor(Math.random() * nx);
      const y = Math.floor(Math.random() * ny);
      seen.add(`${x},${y}`);
    }
    for (const key of seen) {
      const [x, y] = key.split(',').map(Number);
      out.push({ z, x: x as number, y: y as number });
    }
  }
  return out;
}

type TileSample = {
  wallMs: number;
  rankMs: number;
  composeMs: number;
  xCache: string | null;
};

async function fetchTile(
  session: Session,
  boardId: string,
  sortId: string,
  t: { z: number; x: number; y: number },
): Promise<TileSample> {
  const start = performance.now();
  const res = await session.getRaw(
    `/boards/${boardId}/tiles/${sortId}/${t.z}/${t.x}/${t.y}.png`,
  );
  await res.arrayBuffer();
  const wallMs = performance.now() - start;
  const timing = res.headers.get('Server-Timing') ?? '';
  const rankMs = Number(/rank;dur=([\d.]+)/.exec(timing)?.[1] ?? -1);
  const composeMs = Number(/compose;dur=([\d.]+)/.exec(timing)?.[1] ?? -1);
  return { wallMs, rankMs, composeMs, xCache: res.headers.get('X-Cache') };
}

async function boardImageCount(boardId: string): Promise<number> {
  const { rows } = await pool.query(
    'SELECT image_count FROM boards WHERE id = $1',
    [boardId],
  );
  if (rows.length === 0) throw new Error(`no board ${boardId}`);
  return rows[0].image_count as number;
}

// -- rank: cold rebuild, three sorts ----------------------------------------
async function cmdRank(boardId: string): Promise<void> {
  const session = await signInMember();
  const out: { sortId: string; ms: number; httpMs: number }[] = [];
  for (const sortId of SORTS) {
    // The whole order lives in this row (0017_rank_order.sql).
    await pool.query(
      'DELETE FROM board_rank_state WHERE board_id = $1 AND sort_id = $2',
      [boardId, sortId],
    );
    const start = performance.now();
    const res = await session.post(`/boards/${boardId}/sort/${sortId}/rebuild`);
    const httpMs = performance.now() - start;
    if (res.status !== 202) {
      throw new Error(`rebuild ${sortId} failed: ${JSON.stringify(res.json)}`);
    }
    const { rows } = await pool.query(
      'SELECT built_at FROM board_rank_state WHERE board_id = $1 AND sort_id = $2',
      [boardId, sortId],
    );
    out.push({ sortId, ms: httpMs, httpMs });
    console.error(
      `rank rebuild ${sortId}: ${httpMs.toFixed(1)}ms (built_at=${rows[0]?.built_at})`,
    );
  }
  console.log(JSON.stringify({ step: 'rank', boardId, results: out }, null, 2));
  await pool.end();
}

// -- tiles: 500 random tiles per zoom, warm --------------------------------
//
// "Warm" means the LADDER page LRU (tile-cache-is-for-the-second-viewer.md)
// is resident — it does NOT mean requesting the same tile twice, because
// the server also has a 64 MB composed-TILE cache keyed by URL
// (boards/tiles-cache.ts), and a coarse zoom's tile space is small enough
// (z=-5 is 16x16=256 possible tiles) that any second pass over the same or
// even a fresh random sample mostly re-hits it. That cache answers a
// SECOND VIEWER, not this question, so it has to be forced empty for the
// measured pass: `POST .../rebuild` calls invalidateComposedTiles(boardId)
// as a side effect of marking ranks fresh again, without touching ladder
// residency (a different, server-process-level cache). The measured pass
// then samples FRESH random tiles, so every one is a genuine compose.
async function cmdTiles(boardId: string, budgetLabel: string): Promise<void> {
  const session = await signInMember();
  const count = await boardImageCount(boardId);
  const perZoom = 500;

  // warm pass: populate the ladder-page LRU.
  const warmPlan = randomTiles(count, ZOOMS, perZoom);
  for (const t of warmPlan) await fetchTile(session, boardId, TILE_SORT, t);

  const rebuild = await session.post(
    `/boards/${boardId}/sort/${TILE_SORT}/rebuild`,
  );
  if (rebuild.status !== 202) {
    throw new Error(
      `rebuild before measured pass failed: ${JSON.stringify(rebuild.json)}`,
    );
  }

  // measured pass: a fresh sample, so every request is a genuine miss on
  // the composed-tile cache (confirmed below via the X-Cache tally).
  const measuredPlan = randomTiles(count, ZOOMS, perZoom);
  const byZoom = new Map<Zoom, TileSample[]>();
  for (const t of measuredPlan) {
    const s = await fetchTile(session, boardId, TILE_SORT, t);
    const list = byZoom.get(t.z) ?? [];
    list.push(s);
    byZoom.set(t.z, list);
  }

  const results: Record<
    string,
    {
      wallP50: number;
      wallP95: number;
      rankP50: number;
      composeP50: number;
      xCache: Record<string, number>;
    }
  > = {};
  for (const z of ZOOMS) {
    const samples = byZoom.get(z) ?? [];
    const xCache: Record<string, number> = {};
    for (const s of samples) {
      const k = s.xCache ?? 'none';
      xCache[k] = (xCache[k] ?? 0) + 1;
    }
    results[String(z)] = {
      wallP50: percentile(
        samples.map((s) => s.wallMs),
        50,
      ),
      wallP95: percentile(
        samples.map((s) => s.wallMs),
        95,
      ),
      rankP50: percentile(
        samples.map((s) => s.rankMs),
        50,
      ),
      composeP50: percentile(
        samples.map((s) => s.composeMs),
        50,
      ),
      xCache,
    };
    console.error(
      `z=${z}: wall p50=${results[String(z)]?.wallP50.toFixed(2)}ms p95=${results[String(z)]?.wallP95.toFixed(2)}ms`,
    );
  }

  console.log(
    JSON.stringify(
      {
        step: 'tiles',
        boardId,
        budgetLabel,
        sortId: TILE_SORT,
        perZoom,
        results,
      },
      null,
      2,
    ),
  );
  await pool.end();
}

// -- materialise: rebuild + enqueue, poll until every z<=-3 tile file exists
async function cmdMaterialise(boardId: string): Promise<void> {
  const session = await signInMember();

  // Clear the queue — WORKER=off on the measured server means every earlier
  // `rank` step's auto-enqueued materialise job is still sitting there
  // pending; without clearing, starting a worker for this step would also
  // drain those, contending with the one job we're timing.
  await pool.query('DELETE FROM jobs');

  const worker = Bun.spawn(['bun', 'run', 'worker'], {
    cwd: new URL('..', import.meta.url).pathname,
    stdout: 'ignore',
    stderr: 'ignore',
  });

  try {
    const t0 = performance.now();
    const res = await session.post(
      `/boards/${boardId}/sort/${TILE_SORT}/rebuild`,
    );
    if (res.status !== 202) {
      throw new Error(`rebuild failed: ${JSON.stringify(res.json)}`);
    }

    const deadline = Date.now() + 600_000;
    let materialisedAt: string | null = null;
    for (;;) {
      const { rows } = await pool.query(
        'SELECT materialised_at FROM board_rank_state WHERE board_id = $1 AND sort_id = $2',
        [boardId, TILE_SORT],
      );
      const m = rows[0]?.materialised_at as Date | null | undefined;
      if (m) {
        materialisedAt = m.toISOString();
        break;
      }
      if (Date.now() >= deadline)
        throw new Error('materialise timed out (600s)');
      await new Promise((r) => setTimeout(r, 200));
    }
    const materialiseMs = performance.now() - t0;

    // sanity: confirm every expected file is actually present on disk.
    const count = await boardImageCount(boardId);
    let expected = 0;
    let present = 0;
    for (const z of [-3, -4, -5] as const) {
      const { nx, ny } = tileGrid(count, z);
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          expected++;
          const path = `${env.DATA_DIR}/boards/${boardId}/tiles/${TILE_SORT}/${z}/${x}-${y}.png`;
          if (existsSync(path)) present++;
        }
      }
    }

    console.log(
      JSON.stringify(
        {
          step: 'materialise',
          boardId,
          sortId: TILE_SORT,
          materialiseMs,
          materialisedAt,
          expectedTiles: expected,
          presentTiles: present,
        },
        null,
        2,
      ),
    );
  } finally {
    worker.kill();
    await worker.exited;
  }
  await pool.end();
}

// -- coarse: 500 random z<=-3 tiles after materialisation, confirm disk ----
async function cmdCoarse(boardId: string): Promise<void> {
  const session = await signInMember();
  const count = await boardImageCount(boardId);
  const zooms = [-3, -4, -5] as const;
  const plan: { z: Zoom; x: number; y: number }[] = [];
  for (let i = 0; i < 500; i++) {
    const z = zooms[Math.floor(Math.random() * zooms.length)] as Zoom;
    const { nx, ny } = tileGrid(count, z);
    plan.push({
      z,
      x: Math.floor(Math.random() * nx),
      y: Math.floor(Math.random() * ny),
    });
  }

  const samples: TileSample[] = [];
  for (const t of plan)
    samples.push(await fetchTile(session, boardId, TILE_SORT, t));

  const xCache: Record<string, number> = {};
  for (const s of samples) {
    const k = s.xCache ?? 'none';
    xCache[k] = (xCache[k] ?? 0) + 1;
  }

  console.log(
    JSON.stringify(
      {
        step: 'coarse',
        boardId,
        sortId: TILE_SORT,
        n: samples.length,
        wallP50: percentile(
          samples.map((s) => s.wallMs),
          50,
        ),
        wallP95: percentile(
          samples.map((s) => s.wallMs),
          95,
        ),
        xCache,
      },
      null,
      2,
    ),
  );
  await pool.end();
}

// -- viewer: real Playwright against the real web app ------------------------
async function cmdViewer(boardId: string, webOrigin: string): Promise<void> {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1400, height: 900 },
  });

  await page.goto(webOrigin);
  await page.waitForSelector('[data-testid="email"]', { timeout: 20000 });
  await page.fill('[data-testid="email"]', MEMBER_EMAIL);
  await page.fill('[data-testid="password"]', MEMBER_PASSWORD);
  await page.click('[data-testid="submit"]');
  await page.waitForURL(/\/groups/, { timeout: 20000 });

  await page.goto(`${webOrigin}/b/${boardId}`);
  await page.waitForSelector('[data-testid="status"]', { timeout: 20000 });

  // Passed to Playwright as source strings (not TS closures) so this file's
  // tsc run — no DOM lib, it's server code — never has to see `document`.
  const RESET_PREDICATE = `(() => { const el = document.querySelector('[data-testid="status"]'); return !!el && /ttft=-(?!\\d)/.test(el.textContent || ''); })()`;
  const RESOLVED_PREDICATE = `(() => { const el = document.querySelector('[data-testid="status"]'); return !!el && /ttft=\\d+ms/.test(el.textContent || ''); })()`;

  async function waitForTtftReset(): Promise<void> {
    await page.waitForFunction(RESET_PREDICATE, undefined, { timeout: 10_000 });
  }
  async function waitForTtftResolved(): Promise<number> {
    await page.waitForFunction(RESOLVED_PREDICATE, undefined, {
      timeout: 30_000,
    });
    const text = (await page.textContent('[data-testid="status"]')) ?? '';
    const m = /ttft=(\d+)ms/.exec(text);
    if (!m) throw new Error(`couldn't read ttft from status line: ${text}`);
    return Number(m[1]);
  }

  // initial fit's first tile
  const initialTtft = await waitForTtftResolved();

  // one-time setup: flip dir to asc while key is still the default
  // (uploaded_at) — this lands on uploaded_at.asc, never rebuilt, so it
  // pays a cold rebuild. Not part of the measured reps; done once so every
  // later toggle (key-select alone, dir held at asc) moves between two
  // ALREADY-BUILT sorts in one atomic UI action.
  await page.click('[data-testid="sort-dir"]');
  await waitForTtftReset();
  await waitForTtftResolved();

  await page.selectOption('[data-testid="sort-key"]', { label: 'year' });
  await waitForTtftReset();
  await waitForTtftResolved(); // p.number.year.asc, already built — settle once, untimed

  const reps: number[] = [];
  for (let i = 0; i < 5; i++) {
    const label = i % 2 === 0 ? 'Name' : 'year';
    await page.selectOption('[data-testid="sort-key"]', { label });
    await waitForTtftReset();
    const ttft = await waitForTtftResolved();
    reps.push(ttft);
    console.error(`viewer rep ${i}: sort-key -> ${label}: ttft=${ttft}ms`);
  }

  await page.screenshot({
    path: new URL('../../docs/measurements/phase-1-viewer.png', import.meta.url)
      .pathname,
  });

  await browser.close();

  console.log(
    JSON.stringify(
      {
        step: 'viewer',
        boardId,
        initialTtft,
        reps,
        median: median(reps),
      },
      null,
      2,
    ),
  );
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'rank') {
    const [boardId] = rest;
    if (!boardId) throw new Error('usage: rank <boardId>');
    await cmdRank(boardId);
  } else if (cmd === 'tiles') {
    const [boardId, budgetLabel] = rest;
    if (!boardId || !budgetLabel)
      throw new Error('usage: tiles <boardId> <budgetLabel>');
    await cmdTiles(boardId, budgetLabel);
  } else if (cmd === 'materialise') {
    const [boardId] = rest;
    if (!boardId) throw new Error('usage: materialise <boardId>');
    await cmdMaterialise(boardId);
  } else if (cmd === 'coarse') {
    const [boardId] = rest;
    if (!boardId) throw new Error('usage: coarse <boardId>');
    await cmdCoarse(boardId);
  } else if (cmd === 'viewer') {
    const [boardId, webOrigin] = rest;
    if (!boardId || !webOrigin)
      throw new Error('usage: viewer <boardId> <webOrigin>');
    await cmdViewer(boardId, webOrigin);
  } else {
    console.error(
      'usage: bun run scripts/measure-map.ts <rank|tiles|materialise|coarse|viewer> <boardId> [...]',
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('measure-map failed:', err);
  process.exit(1);
});
