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
};
