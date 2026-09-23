// Bun loads `.env` from the process's cwd. Every script here is meant to run
// with cwd = server/ (`bun run <script>` inside the server workspace, or the
// root filters), but the real `.env` lives at the repo root (`app/.env`), so
// it is loaded explicitly here and never overwrites a variable the shell
// already set.
import { existsSync, readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '../..'); // server/src -> server -> app
const ROOT_ENV = join(REPO_ROOT, '.env');

if (existsSync(ROOT_ENV)) {
  const text = readFileSync(ROOT_ENV, 'utf8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var ${name}`);
  return v;
}

// PORT is the one authority for which port the server binds. SERVER_ORIGIN
// (and, through it, Better Auth's baseURL in auth.ts) must never disagree
// with it — a mismatch breaks cookies and the CSRF Origin check — so PORT
// always overrides whatever port SERVER_ORIGIN names, .env's default
// included, UNLESS PUBLIC_ORIGIN is set (below), in which case that's the
// origin, verbatim, port and all. Two servers on one machine (a dev
// instance and a check run against another port, say) set PORT and get a
// consistent origin for free.
const PORT = Number(process.env.PORT ?? 8800);

function parseWorkerMode(
  value: string | undefined,
): 'process' | 'inline' | 'off' {
  if (value === undefined || value === '') return 'process';
  if (value === 'process' || value === 'inline' || value === 'off')
    return value;
  throw new Error(`WORKER must be process, inline or off; got ${value}`);
}

function withPort(origin: string, port: number): string {
  try {
    const u = new URL(origin);
    u.port = String(port);
    return u.toString().replace(/\/$/, '');
  } catch {
    return origin;
  }
}

export const env = {
  DATABASE_URL: required('DATABASE_URL'),
  AUTH_SECRET: required('AUTH_SECRET'),
  PORT,
  // Phase 5 section 3 (docs/phases/5-hardening.md): the bind address, never
  // the origin — `127.0.0.1` by default so a dev server is unreachable off
  // the box (node's `http.Server#listen(port)` with no host binds every
  // interface, `::`, which is the actual exposure this closes; see index.ts).
  // Compose sets this to `0.0.0.0` explicitly (a container's loopback isn't
  // reachable from the `caddy` container) — "prod binds what compose says".
  HOST: process.env.HOST ?? '127.0.0.1',
  // `PUBLIC_ORIGIN` wins over `SERVER_ORIGIN`+PORT when set, and is used
  // exactly as given — no `withPort`. Behind Caddy the server's real,
  // externally-visible origin (`https://api.DOMAIN`, no port: Caddy
  // terminates TLS and proxies to the container's internal PORT) is not the
  // same thing as "SERVER_ORIGIN with PORT forced on", which is what
  // `withPort` below still does for local dev (no reverse proxy, the origin
  // IS `http://localhost:PORT`). Better Auth's `baseURL` (auth.ts) — and
  // through it, whether cookies get `Secure` (cookies/index.ts: `secure =
  // baseURL.startsWith('https://')` when `advanced.useSecureCookies` isn't
  // set, which it isn't here) — reads this value, so getting it right here
  // is what makes cookies close over http and Secure over https with no
  // separate flag.
  SERVER_ORIGIN: process.env.PUBLIC_ORIGIN
    ? process.env.PUBLIC_ORIGIN.replace(/\/$/, '')
    : withPort(process.env.SERVER_ORIGIN ?? 'http://localhost:8800', PORT),
  WEB_ORIGIN: process.env.WEB_ORIGIN ?? 'http://localhost:5180',
  DATA_DIR: resolve(REPO_ROOT, process.env.DATA_DIR ?? './data'),
  // auth.ts's `session` option — how long a session lives and how often its
  // expiry is pushed out on use. Seconds, Better Auth's own units.
  SESSION_EXPIRES_IN: Number(
    process.env.SESSION_EXPIRES_IN ?? 60 * 60 * 24 * 7,
  ),
  SESSION_UPDATE_AGE: Number(process.env.SESSION_UPDATE_AGE ?? 60 * 60 * 24),
  // auth.ts's `rateLimit` option: the general window/max Better Auth falls
  // back to for a path with no tighter special-case rule of its own — every
  // sign-in/sign-up/change-password/change-email path already gets a
  // stricter built-in rule (window 10s, max 3) that this does not widen.
  // `enabled` is deliberately left unset (`isProduction` by Better Auth's
  // own default): forcing it on here would rate-limit this repo's own test
  // suite, which signs up and signs in dozens of users from one IP inside
  // one `bun test` run — see auth.ts's comment.
  AUTH_RATE_LIMIT_WINDOW: Number(process.env.AUTH_RATE_LIMIT_WINDOW ?? 10),
  AUTH_RATE_LIMIT_MAX: Number(process.env.AUTH_RATE_LIMIT_MAX ?? 100),
  // limits.ts's token buckets, one action each — docs/phases/5-hardening.md
  // section 2. Uploads: 200 files/s sustained, above the ~75/s the worker
  // processes, so one person importing never waits on it; at 6,000 a fast
  // 20,000-file import drew 7-66 retried 429s (2026-09-23).
  RATE_UPLOAD_PER_MIN: Number(process.env.RATE_UPLOAD_PER_MIN ?? 12_000),
  RATE_TUS_CREATE_PER_MIN: Number(process.env.RATE_TUS_CREATE_PER_MIN ?? 600),
  RATE_SOCKET_CONNECT_PER_MIN: Number(
    process.env.RATE_SOCKET_CONNECT_PER_MIN ?? 30,
  ),
  RATE_SCENE_EMIT_PER_SEC: Number(process.env.RATE_SCENE_EMIT_PER_SEC ?? 30),
  // boards/validate.ts: an upload's byte size cap and, read from its header
  // before decode, its pixel budget (width*height) — docs/phases/
  // 5-hardening.md section 2.
  UPLOAD_MAX_MB: Number(process.env.UPLOAD_MAX_MB ?? 50),
  // Aggregate multipart body cap, applied while reading the request stream
  // before form parsing or per-file buffering.
  UPLOAD_BATCH_MAX_MB: Number(process.env.UPLOAD_BATCH_MAX_MB ?? 100),
  UPLOAD_MAX_PIXELS: Number(process.env.UPLOAD_MAX_PIXELS ?? 100_000_000),
  // storage/room.ts: uploads stop while the data volume has less than this
  // free (STORAGE=fs only); 0 turns the guard off.
  UPLOAD_MIN_FREE_GB: Number(process.env.UPLOAD_MIN_FREE_GB ?? 5),
  // worker/jobs.ts#runLadderJob: `loadImage` is wrapped in this timeout, so
  // a pathological file can fail fast instead of tying up a worker slot.
  DECODE_TIMEOUT_MS: Number(process.env.DECODE_TIMEOUT_MS ?? 15_000),
  // metrics.ts: GET /metrics is 404 (not just unauthorized — existence
  // shouldn't be advertised either) unless this is set; a bearer token or
  // `?token=`, checked against this exact string. No default: an operator
  // opts in on purpose, same posture as AUTH_SECRET.
  METRICS_TOKEN: process.env.METRICS_TOKEN,
  LADDER_BUDGET_MB: Number(process.env.LADDER_BUDGET_MB ?? 4096),
  // boards/ladder.ts's per-board eviction floor (docs/measurements/
  // phase-5.md "After the leftovers", problem 2): a board counts as
  // "active" — and gets a floor share of LADDER_BUDGET_MB protected from
  // eviction by every OTHER board's traffic — while it has been read from
  // within this window. 5 minutes: long enough to survive a viewer
  // reading one tile then thinking for a moment, short enough that a
  // board nobody's looked at in a while stops holding a floor share other
  // open boards could use.
  LADDER_ACTIVE_WINDOW_MS: Number(
    process.env.LADDER_ACTIVE_WINDOW_MS ?? 5 * 60 * 1000,
  ),
  INVITATION_EXPIRES_IN: Number(process.env.INVITATION_EXPIRES_IN ?? 172800),
  // The in-process worker's poll concurrency (docs/phases/1-map.md "Upload
  // as a worker"). No longer materialise.ts's parallelism — see
  // MATERIALISE_BUDGET_MB below; PNG encoding there is sized off CPU count,
  // not this.
  WORKER_CONCURRENCY: Number(process.env.WORKER_CONCURRENCY ?? 4),
  // Where the worker runs (worker/supervisor.ts). `process`: a child the
  // server restarts, so a native-memory leak in image work can take down
  // the worker and never the API — docs/measurements/bulk-import-20000.md.
  // `inline`: inside the server, as before. `off`: not at all (run
  // `bun run worker` elsewhere).
  WORKER: parseWorkerMode(process.env.WORKER),
  // A worker process finishes its batch and exits past either bound; the
  // supervisor starts a fresh one. Jobs are leased, so nothing is lost.
  WORKER_RSS_LIMIT_MB: Number(process.env.WORKER_RSS_LIMIT_MB ?? 3072),
  WORKER_MAX_JOBS: Number(process.env.WORKER_MAX_JOBS ?? 50_000),
  // boards/materialise.ts's scatter path allocates every z<=-3 tile canvas
  // for a sort up front (RGBA, before PNG encoding) — this bounds that, and
  // materialiseSort throws rather than allocate past it. ~1.3 GB at
  // 1,000,000 images (docs/measurements/phase-1-map.md "Row 4").
  MATERIALISE_BUDGET_MB: Number(process.env.MATERIALISE_BUDGET_MB ?? 2048),
  // meaning/clip.ts: CLIP embeddings for similarity and text search. Off
  // unless set to `on`: the first use downloads ~150 MB of weights into
  // DATA_DIR/models, and each worker holds the image model (~300 MB).
  EMBEDDINGS: process.env.EMBEDDINGS === 'on',
  // Where CLIP's weights are kept. DATA_DIR/models by default; a test run
  // that starts from a fresh DATA_DIR each time points this at one kept
  // folder, or downloads ~150 MB every run.
  // meaning/embeddings.ts: a board's vectors are packed as float32 while
  // they fit this (1.5 GB is 750,000 images), int8 beyond it, so the
  // worker's arrangement stays bounded however large the board.
  // storage/quota.ts: the storage quota of a group that has none of its
  // own, in GB. 0 (the default) is no quota; usage is still counted.
  GROUP_QUOTA_GB: Number(process.env.GROUP_QUOTA_GB ?? 0),
  ARRANGE_BUDGET_MB: Number(process.env.ARRANGE_BUDGET_MB ?? 1536),
  MODELS_DIR: resolve(
    REPO_ROOT,
    process.env.MODELS_DIR ?? join(process.env.DATA_DIR ?? './data', 'models'),
  ),
  // boards/folder-import.ts: folders the server may import from, separated
  // by ':'. Empty (the default) turns folder import off: reading the
  // server's disk is the operator's decision, never a user's.
  IMPORT_ROOTS: (process.env.IMPORT_ROOTS ?? '')
    .split(':')
    .map((root) => root.trim())
    .filter(Boolean),
  IMPORT_MAX_FILES: Number(process.env.IMPORT_MAX_FILES ?? 100_000),
  // boards/ranks.ts: decoded rank orders held per process, ~8 MB per sort of
  // a million-image board.
  RANK_CACHE_MB: Number(process.env.RANK_CACHE_MB ?? 256),
  // PNG-encode threads per materialise (boards/materialise.ts#EncodePool).
  // Each is a whole JS heap; the default leaves two cores free and caps at
  // eight so a large machine's core count does not become a memory spike.
  MATERIALISE_ENCODERS: Number(
    process.env.MATERIALISE_ENCODERS ??
      Math.max(1, Math.min(availableParallelism() - 2, 8)),
  ),
  // boards/coarse-cache.ts: a materialised sort's z<=-3 tiles held resident
  // per open board, LRU across (board, sort) — .claude/rules/
  // tile-cache-is-for-the-second-viewer.md. ~124 MB per sort at 1,000,000
  // images.
  COARSE_BUDGET_MB: Number(process.env.COARSE_BUDGET_MB ?? 1024),
  // storage/index.ts#storageFromEnv: 'fs' (today's DATA_DIR layout) or 's3'
  // (any S3-compatible endpoint, path-style — the dev compose's `minio`
  // service, or a real bucket in production). The S3_* vars are required
  // only when STORAGE=s3; storage/s3.ts throws its own clear error naming
  // whichever one is missing, rather than this module throwing a generic
  // "missing required env var" for a variable most deployments never set.
  STORAGE: (process.env.STORAGE ?? 'fs') as 'fs' | 's3',
  S3_ENDPOINT: process.env.S3_ENDPOINT,
  S3_BUCKET: process.env.S3_BUCKET,
  S3_ACCESS_KEY: process.env.S3_ACCESS_KEY,
  S3_SECRET_KEY: process.env.S3_SECRET_KEY,
  S3_REGION: process.env.S3_REGION ?? 'us-east-1',
};
