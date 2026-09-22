import { residentBytes as coarseBytes } from './boards/coarse-cache.ts';
import {
  residentBytes as ladderBytes,
  evictionCount as ladderEvictions,
} from './boards/ladder.ts';
// Phase 5 section 4 (docs/phases/5-hardening.md "Operability"): GET
// /metrics, Prometheus text format, protected by METRICS_TOKEN. Fed by two
// call sites elsewhere — logging.ts#logRequest (request counts + latency,
// one hook, so a new request-finish path can't log without also metering)
// and boards/routes.ts's tile route (recordTileCache, by X-Cache) — plus
// two live reads at render time (the worker queue and the sheet room don't
// change fast enough to justify counters that could drift from the source
// of truth).
//
// Plus three residency reads: ladder bytes and evictions, coarse-tile
// bytes — the numbers the phase-5 load run needed and could not see.
import { pool } from './db/pool.ts';
import { env } from './env.ts';
import type { Router } from './http.ts';
import { roomCounts } from './sheets/room.ts';

const LATENCY_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

type Histogram = { counts: number[]; sum: number; total: number };

function newHistogram(): Histogram {
  return {
    counts: new Array(LATENCY_BUCKETS_MS.length + 1).fill(0),
    sum: 0,
    total: 0,
  };
}

// Keys are `\u0001`-joined tuples, never plain string interpolation — a
// route pattern or status is attacker-adjacent (an unmatched path is
// labelled '(unmatched)' rather than echoed, precisely so this map can't
// grow one entry per scanned URL) but a delimiter collision would still be
// a correctness bug, not just a label typo.
const SEP = '\u0001';

const requestCounts = new Map<string, number>(); // method,route,status -> n
const requestLatency = new Map<string, Histogram>(); // method,route -> histogram
const tileCacheCounts = new Map<string, number>(); // cache -> n

export function recordRequest(
  method: string,
  route: string,
  status: number,
  ms: number,
): void {
  const ckey = [method, route, String(status)].join(SEP);
  requestCounts.set(ckey, (requestCounts.get(ckey) ?? 0) + 1);

  const hkey = [method, route].join(SEP);
  let h = requestLatency.get(hkey);
  if (!h) {
    h = newHistogram();
    requestLatency.set(hkey, h);
  }
  h.sum += ms;
  h.total += 1;
  const bucketIndex = LATENCY_BUCKETS_MS.findIndex((bound) => ms <= bound);
  const i = bucketIndex === -1 ? LATENCY_BUCKETS_MS.length : bucketIndex;
  h.counts[i] = (h.counts[i] ?? 0) + 1;
}

export function recordTileCache(cache: string): void {
  tileCacheCounts.set(cache, (tileCacheCounts.get(cache) ?? 0) + 1);
}

async function workerQueueDepth(): Promise<{ state: string; n: number }[]> {
  const { rows } = await pool.query(
    'SELECT state, COUNT(*)::int AS n FROM jobs GROUP BY state',
  );
  return rows.map((r) => ({ state: r.state as string, n: r.n as number }));
}

function esc(label: string): string {
  return label.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '');
}

/** Renders the whole page fresh on every scrape — the counters above are
 * already O(distinct route/status), so there's nothing to cache. */
export async function renderMetrics(): Promise<string> {
  const lines: string[] = [];

  lines.push(
    '# HELP digsite_requests_total Requests by method, route and status.',
  );
  lines.push('# TYPE digsite_requests_total counter');
  for (const [key, n] of requestCounts) {
    const [method, route, status] = key.split(SEP);
    lines.push(
      `digsite_requests_total{method="${esc(method ?? '')}",route="${esc(route ?? '')}",status="${esc(status ?? '')}"} ${n}`,
    );
  }

  lines.push(
    '# HELP digsite_request_duration_ms Request latency, milliseconds.',
  );
  lines.push('# TYPE digsite_request_duration_ms histogram');
  for (const [key, h] of requestLatency) {
    const [method, route] = key.split(SEP);
    const labels = `method="${esc(method ?? '')}",route="${esc(route ?? '')}"`;
    let cumulative = 0;
    for (let i = 0; i < LATENCY_BUCKETS_MS.length; i++) {
      cumulative += h.counts[i] ?? 0;
      lines.push(
        `digsite_request_duration_ms_bucket{${labels},le="${LATENCY_BUCKETS_MS[i]}"} ${cumulative}`,
      );
    }
    cumulative += h.counts[LATENCY_BUCKETS_MS.length] ?? 0;
    lines.push(
      `digsite_request_duration_ms_bucket{${labels},le="+Inf"} ${cumulative}`,
    );
    lines.push(`digsite_request_duration_ms_sum{${labels}} ${h.sum}`);
    lines.push(`digsite_request_duration_ms_count{${labels}} ${h.total}`);
  }

  lines.push(
    '# HELP digsite_tile_cache_total Tile responses by X-Cache value.',
  );
  lines.push('# TYPE digsite_tile_cache_total counter');
  for (const [cache, n] of tileCacheCounts) {
    lines.push(`digsite_tile_cache_total{cache="${esc(cache)}"} ${n}`);
  }

  lines.push('# HELP digsite_ladder_resident_bytes Decoded ladder pages held.');
  lines.push('# TYPE digsite_ladder_resident_bytes gauge');
  lines.push(`digsite_ladder_resident_bytes ${ladderBytes()}`);
  lines.push('# HELP digsite_ladder_evictions_total Ladder pages evicted.');
  lines.push('# TYPE digsite_ladder_evictions_total counter');
  lines.push(`digsite_ladder_evictions_total ${ladderEvictions()}`);
  lines.push('# HELP digsite_coarse_resident_bytes Coarse tiles held.');
  lines.push('# TYPE digsite_coarse_resident_bytes gauge');
  lines.push(`digsite_coarse_resident_bytes ${coarseBytes()}`);
  lines.push('# HELP digsite_worker_queue_depth Jobs table rows by state.');
  lines.push('# TYPE digsite_worker_queue_depth gauge');
  for (const { state, n } of await workerQueueDepth()) {
    lines.push(`digsite_worker_queue_depth{state="${esc(state)}"} ${n}`);
  }

  const rc = roomCounts();
  lines.push(
    '# HELP digsite_sheet_rooms Open sheet rooms (sockets joined to at least one).',
  );
  lines.push('# TYPE digsite_sheet_rooms gauge');
  lines.push(`digsite_sheet_rooms ${rc.rooms}`);
  lines.push(
    '# HELP digsite_sheet_peers Sockets currently joined to a sheet room.',
  );
  lines.push('# TYPE digsite_sheet_peers gauge');
  lines.push(`digsite_sheet_peers ${rc.peers}`);

  return `${lines.join('\n')}\n`;
}

/** Test-only: a fresh process's worth of counters, so a metrics test
 * doesn't depend on what earlier tests in the same run recorded. */
export function resetMetricsForTest(): void {
  requestCounts.clear();
  requestLatency.clear();
  tileCacheCounts.clear();
}

function tokenFrom(req: {
  headers: Record<string, string | string[] | undefined>;
  url?: string;
}): string | null {
  const auth = req.headers.authorization;
  const authHeader = Array.isArray(auth) ? auth[0] : auth;
  if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7);
  const url = new URL(req.url ?? '/', 'http://internal');
  return url.searchParams.get('token');
}

/** GET /metrics — 404 (existence unadvertised) with no token configured
 * or the wrong one presented; 200 text/plain otherwise. No session check:
 * a Prometheus scraper carries no cookie, and the token is the auth.
 * `token` defaults to `env.METRICS_TOKEN` but is a parameter (not read
 * from `env` inline below) so a test can exercise "configured" vs "not
 * configured" without mutating process.env — which, after env.ts's
 * read-once-at-import pattern, a test can't do reliably once another test
 * file has already imported it first (see metrics.test.ts's own
 * comment). */
export function registerMetricsRoutes(
  router: Router,
  token: string | undefined = env.METRICS_TOKEN,
): void {
  router.get('/metrics', async (ctx) => {
    if (!token) {
      ctx.res.writeHead(404, { 'Content-Type': 'application/json' });
      ctx.res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    const presented = tokenFrom({ headers: ctx.req.headers, url: ctx.req.url });
    if (presented !== token) {
      ctx.res.writeHead(404, { 'Content-Type': 'application/json' });
      ctx.res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    const body = await renderMetrics();
    ctx.res.writeHead(200, {
      'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
    });
    ctx.res.end(body);
  });
}
