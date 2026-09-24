#!/usr/bin/env bun
// docs/phases/5-hardening.md section 6: creates a fresh database on the
// running `digsite-db` container, migrates, seeds through the real HTTP API
// (server/src/seed.ts's own pattern), starts server and web on free ports
// with a temp DATA_DIR, runs the scripted e2e suites
// (e2e/src/{upload-queue,board-selection,run,groups-life,sheet-hour}.ts), then tears
// everything down: stops both processes, drops the database, deletes the
// temp dir. Exits nonzero on any suite failure or setup error.
//
// `bun run e2e:fresh` at the repo root. The sheet uses its native canvas.
// Pass suite paths for a focused fresh run, e.g. src/upload-queue.ts.
//
// Never touches the owner's dev instances (server :8800, web :5180) or any
// container but `digsite-db`: ports are picked free at or above 8850/5250,
// and the database this script creates and drops is always a new
// `digsite_e2e_<ts>` name on that one container — never `digsite` itself.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findFreePort, waitUp } from './net.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..'); // scripts -> app
const SERVER_DIR = join(REPO_ROOT, 'server');
const WEB_DIR = join(REPO_ROOT, 'web');
const E2E_DIR = join(REPO_ROOT, 'e2e');

const SERVER_PORT_BASE = 8850;
const WEB_PORT_BASE = 5250;
const FORBIDDEN_PORTS = new Set([8800, 5180]); // the owner's demo — never these

const PG_CONTAINER = 'digsite-db'; // the only container this script may touch
const BASE_DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://digsite:digsite@127.0.0.1:5440/digsite';
const HOUR_ACTIONS = process.env.HOUR_ACTIONS ?? '60';
const SUITE_PATHS = [
  'src/upload-queue.ts',
  'src/board-selection.ts',
  'src/run.ts',
  'src/groups-life.ts',
  'src/sheet-hour.ts',
  // CONTEXT.md "Making sense", walked through the real app as people would.
  'src/sense-claims.ts',
  // Last: it gives outsider@example.test a new password.
  'src/operator-accounts.ts',
];
const requested = process.argv.slice(2);
if (requested.some((path) => !SUITE_PATHS.includes(path))) {
  throw new Error(`Unknown suite. Choose from: ${SUITE_PATHS.join(', ')}`);
}
const selected = requested.length ? requested : SUITE_PATHS;

function log(msg: string): void {
  console.log(`[e2e-fresh] ${msg}`);
}

function dbUrl(name: string): string {
  const u = new URL(BASE_DATABASE_URL);
  u.pathname = `/${name}`;
  return u.toString();
}

function pgUser(): string {
  return new URL(BASE_DATABASE_URL).username || 'digsite';
}

// -- process helpers ----------------------------------------------------------

function run(
  cmd: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): void {
  log(`$ ${cmd.join(' ')}`);
  const res = Bun.spawnSync(cmd, {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) } as Record<string, string>,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if (res.exitCode !== 0) {
    throw new Error(`command failed (${res.exitCode}): ${cmd.join(' ')}`);
  }
}

function runChecked(
  cmd: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): boolean {
  log(`$ ${cmd.join(' ')}`);
  const res = Bun.spawnSync(cmd, {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) } as Record<string, string>,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  return res.exitCode === 0;
}

function psql(sql: string): void {
  run([
    'docker',
    'exec',
    PG_CONTAINER,
    'psql',
    '-U',
    pgUser(),
    '-d',
    'postgres',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    sql,
  ]);
}

async function waitReady(origin: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      // health.ts answers 200 only once db+storage+migrations are all true;
      // any other status (503, or a fetch throw before the port is even
      // listening) means "not ready yet".
      const res = await fetch(`${origin}/readyz`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      throw new Error(`${origin}/readyz not ready within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function stopProc(proc: Bun.Subprocess | null): Promise<void> {
  if (!proc) return;
  proc.kill();
  await proc.exited;
}

// -- main ----------------------------------------------------------------------

async function main() {
  const ts = Date.now();
  const dbName = `digsite_e2e_${ts}`;
  const dataDir = mkdtempSync(join(tmpdir(), 'digsite-e2e-data-'));

  const serverPort = await findFreePort(SERVER_PORT_BASE, FORBIDDEN_PORTS);
  const webPort = await findFreePort(WEB_PORT_BASE, FORBIDDEN_PORTS);
  const serverOrigin = `http://localhost:${serverPort}`;
  const webOrigin = `http://localhost:${webPort}`;

  log(`database=${dbName} dataDir=${dataDir}`);
  log(`server=${serverOrigin} web=${webOrigin}`);

  let serverProc: Bun.Subprocess | null = null;
  let webProc: Bun.Subprocess | null = null;
  let failed = false;

  try {
    // -- fresh database -------------------------------------------------------
    log(`creating database ${dbName} on ${PG_CONTAINER}`);
    psql(`CREATE DATABASE ${dbName}`);

    log('migrating');
    run(['bun', 'run', 'src/db/migrate.ts'], {
      cwd: SERVER_DIR,
      env: { DATABASE_URL: dbUrl(dbName) },
    });

    // -- server -----------------------------------------------------------------
    log('starting server');
    serverProc = Bun.spawn(['bun', 'run', 'src/index.ts'], {
      cwd: SERVER_DIR,
      env: {
        ...process.env,
        DATABASE_URL: dbUrl(dbName),
        PORT: String(serverPort),
        SERVER_ORIGIN: serverOrigin,
        WEB_ORIGIN: webOrigin,
        DATA_DIR: dataDir,
        // Kept across runs: a fresh DATA_DIR would download the CLIP
        // weights (~150 MB) again whenever EMBEDDINGS=on.
        MODELS_DIR: process.env.MODELS_DIR ?? join(REPO_ROOT, '.cache/models'),
        STORAGE: 'fs',
        // The seeded owner is the site's operator (operator-accounts.ts).
        OPERATOR_EMAILS: process.env.OPERATOR_EMAILS ?? 'owner@example.test',
      } as Record<string, string>,
      stdout: 'inherit',
      stderr: 'inherit',
    });
    await waitReady(serverOrigin);
    log('server ready');

    // -- seed (HTTP, against the running server) -------------------------------
    // PORT must come along with SERVER_ORIGIN: env.ts's withPort() rewrites
    // SERVER_ORIGIN's port to match PORT (default 8800) whenever PORT isn't
    // set — without it, seed.ts silently talks to whatever is on :8800
    // instead of this run's own server. Caught by hand: with PORT omitted
    // here, seed.ts read the owner's real dev server on :8800 (already
    // seeded, so it took the "already seeded, skipping" early return and
    // wrote nothing there) while the actual ephemeral server stayed empty —
    // every scenario needing seed data then failed sign-in against it.
    log('seeding');
    run(['bun', 'run', 'src/seed.ts'], {
      cwd: SERVER_DIR,
      env: {
        PORT: String(serverPort),
        SERVER_ORIGIN: serverOrigin,
        DATABASE_URL: dbUrl(dbName),
      },
    });

    // -- web --------------------------------------------------------------------
    // The report viewer is its own build (web/vite.viewer.config.ts); the
    // dev server only serves it, so a report made here carries it.
    log('building the report viewer');
    run(['bun', 'run', 'build:viewer'], { cwd: WEB_DIR });
    log('starting web');
    webProc = Bun.spawn(
      ['bun', 'run', 'vite', '--port', String(webPort), '--strictPort'],
      {
        cwd: WEB_DIR,
        env: {
          ...process.env,
          VITE_SERVER_ORIGIN: serverOrigin,
        } as Record<string, string>,
        stdout: 'inherit',
        stderr: 'inherit',
      },
    );
    await waitUp(webOrigin);
    log('web up');

    // -- scripted suites --------------------------------------------------------
    const suiteEnv = { SERVER_ORIGIN: serverOrigin, WEB_ORIGIN: webOrigin };
    const suites = selected.map((path) => ({
      cmd: ['bun', 'run', path],
      env: { ...suiteEnv, HOUR_ACTIONS },
    }));
    for (const suite of suites) {
      const ok = runChecked(suite.cmd, { cwd: E2E_DIR, env: suite.env });
      if (!ok) {
        failed = true;
        log(`FAILED: ${suite.cmd.join(' ')}`);
      }
    }
  } catch (err) {
    failed = true;
    console.error(
      '[e2e-fresh] setup/run error:',
      err instanceof Error ? err.message : err,
    );
  } finally {
    log('tearing down');
    await stopProc(webProc);
    await stopProc(serverProc);

    // Give Postgres a moment to notice the dead server's connections closed
    // before DROP DATABASE — same shape as e2e/src/backup-restore.ts's own
    // stop-then-drop, with a short retry since this script runs three full
    // suites' worth of connections against the pool, not just one.
    let dropped = false;
    for (let attempt = 0; attempt < 5 && !dropped; attempt++) {
      try {
        psql(`DROP DATABASE IF EXISTS ${dbName}`);
        dropped = true;
      } catch (err) {
        if (attempt === 4) {
          console.error(
            `[e2e-fresh] cleanup: drop database ${dbName} failed after retries`,
            err,
          );
        } else {
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    }

    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch (err) {
      console.error('[e2e-fresh] cleanup: remove data dir failed', err);
    }
  }

  if (failed) {
    console.log('\ne2e-fresh: FAIL');
    process.exit(1);
  }
  console.log(`\ne2e-fresh: PASS (${selected.join(', ')})`);
  process.exit(0);
}

main().catch((err) => {
  console.error('e2e-fresh crashed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
