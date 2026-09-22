// Bun loads `.env` from the process's cwd. Every script here is meant to run
// with cwd = server/ (`bun run <script>` inside the server workspace, or the
// root filters), but the real `.env` lives at the repo root (`app/.env`), so
// it is loaded explicitly here and never overwrites a variable the shell
// already set.
import { existsSync, readFileSync } from 'node:fs';
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
// included. Two servers on one machine (a dev instance and a check run
// against another port, say) set PORT and get a consistent origin for free.
const PORT = Number(process.env.PORT ?? 8800);

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
  SERVER_ORIGIN: withPort(
    process.env.SERVER_ORIGIN ?? 'http://localhost:8800',
    PORT,
  ),
  WEB_ORIGIN: process.env.WEB_ORIGIN ?? 'http://localhost:5180',
  DATA_DIR: resolve(REPO_ROOT, process.env.DATA_DIR ?? './data'),
  LADDER_BUDGET_MB: Number(process.env.LADDER_BUDGET_MB ?? 4096),
  INVITATION_EXPIRES_IN: Number(process.env.INVITATION_EXPIRES_IN ?? 172800),
  // The in-process worker's poll concurrency (docs/phases/1-map.md "Upload
  // as a worker"). No longer materialise.ts's parallelism — see
  // MATERIALISE_BUDGET_MB below; PNG encoding there is sized off CPU count,
  // not this.
  WORKER_CONCURRENCY: Number(process.env.WORKER_CONCURRENCY ?? 4),
  // boards/materialise.ts's scatter path allocates every z<=-3 tile canvas
  // for a sort up front (RGBA, before PNG encoding) — this bounds that, and
  // materialiseSort throws rather than allocate past it. ~1.3 GB at
  // 1,000,000 images (docs/measurements/phase-1-map.md "Row 4").
  MATERIALISE_BUDGET_MB: Number(process.env.MATERIALISE_BUDGET_MB ?? 2048),
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
