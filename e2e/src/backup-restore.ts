// docs/phases/4-deploy.md section 4/Tests: seed -> back up -> wipe (a
// FRESH database and a FRESH data dir, never the shared `digsite-db`
// volume itself — a second database name on the same container,
// `digsite_restore`, and a temp data dir) -> restore -> the ten-scenario
// e2e/src/run.ts passes against the restored copy.
//
// Self-contained: spawns its own server process against the real `digsite`
// database and DATA_DIR (whatever this machine's dev stack already has —
// seeding is idempotent, so this never duplicates fixture data), backs
// that up with deploy/backup.sh, restores into `digsite_restore` + a temp
// dir with deploy/restore.sh, then spawns a SECOND server process against
// the restored copy and runs run.ts against it. Assumes a web dev server
// is already running at WEB_ORIGIN (the same assumption run.ts itself
// makes) — this script only owns the two server processes and the
// restored database/data dir, and cleans up both at the end regardless of
// pass or fail.
//
// Run from e2e/ (needs DATA_DIR's board files under a `db` this machine's
// `digsite-db` container serves, i.e. the normal dev stack):
//   bun run backup-restore
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const E2E_DIR = join(HERE, '..');
const REPO_ROOT = join(E2E_DIR, '..');
const SERVER_DIR = join(REPO_ROOT, 'server');
const DEPLOY_DIR = join(REPO_ROOT, 'deploy');

const PORT = process.env.PORT ?? '8809';
const SERVER_ORIGIN = `http://localhost:${PORT}`;
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5189';

const PG_CONTAINER = process.env.PG_CONTAINER ?? 'digsite-db';
const POSTGRES_USER = process.env.POSTGRES_USER ?? 'digsite';
const POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD ?? 'digsite';
const PG_HOST_PORT = process.env.PG_HOST_PORT ?? '5440';
const SOURCE_DB = process.env.SOURCE_DB ?? 'digsite';
const RESTORE_DB = process.env.RESTORE_DB ?? 'digsite_restore';
const SOURCE_DATA_DIR = process.env.SOURCE_DATA_DIR ?? join(REPO_ROOT, 'data');

function dbUrl(db: string): string {
  return `postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${PG_HOST_PORT}/${db}`;
}

function log(msg: string): void {
  console.log(`[backup-restore] ${msg}`);
}

async function waitReady(origin: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
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

function spawnServer(env: Record<string, string>): Bun.Subprocess {
  return Bun.spawn(['bun', 'run', 'src/index.ts'], {
    cwd: SERVER_DIR,
    env: { ...process.env, ...env } as Record<string, string>,
    stdout: 'inherit',
    stderr: 'inherit',
  });
}

async function stopServer(proc: Bun.Subprocess): Promise<void> {
  proc.kill();
  await proc.exited;
}

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

function runCapture(
  cmd: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): string {
  const res = Bun.spawnSync(cmd, {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) } as Record<string, string>,
    stdout: 'pipe',
    stderr: 'inherit',
  });
  if (res.exitCode !== 0) {
    throw new Error(`command failed (${res.exitCode}): ${cmd.join(' ')}`);
  }
  return res.stdout.toString('utf8').trim();
}

function psql(sql: string): void {
  run([
    'docker',
    'exec',
    PG_CONTAINER,
    'psql',
    '-U',
    POSTGRES_USER,
    '-d',
    'postgres',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    sql,
  ]);
}

async function main() {
  const backupRoot = mkdtempSync(join(tmpdir(), 'digsite-backup-'));
  const restoreDataDir = mkdtempSync(join(tmpdir(), 'digsite-restore-data-'));
  let serverA: Bun.Subprocess | null = null;
  let serverB: Bun.Subprocess | null = null;

  try {
    // -- seed the source (real `digsite` db + DATA_DIR) ---------------------
    log(`starting server A against ${SOURCE_DB} / ${SOURCE_DATA_DIR}`);
    serverA = spawnServer({
      DATABASE_URL: dbUrl(SOURCE_DB),
      AUTH_SECRET: process.env.AUTH_SECRET ?? 'backup-restore-test-secret',
      PORT,
      SERVER_ORIGIN,
      WEB_ORIGIN,
      DATA_DIR: SOURCE_DATA_DIR,
      STORAGE: 'fs',
    });
    await waitReady(SERVER_ORIGIN);
    log('server A ready; seeding (idempotent)');
    // PORT must travel with SERVER_ORIGIN: server/src/env.ts's withPort()
    // rewrites SERVER_ORIGIN's port to match PORT (default 8800) whenever
    // PORT isn't set, so without it seed.ts silently talks to whatever is
    // on :8800 instead of server A — found the hard way wiring
    // scripts/e2e-fresh.ts, which had the same gap.
    run(['bun', 'run', 'src/seed.ts'], {
      cwd: SERVER_DIR,
      env: { PORT, SERVER_ORIGIN, DATABASE_URL: dbUrl(SOURCE_DB) },
    });

    // -- back up --------------------------------------------------------------
    log('backing up');
    const backupPath = runCapture(
      ['bash', join(DEPLOY_DIR, 'backup.sh'), backupRoot],
      {
        env: {
          PG_CONTAINER,
          POSTGRES_USER,
          POSTGRES_DB: SOURCE_DB,
          STORAGE: 'fs',
          DATA_DIR: SOURCE_DATA_DIR,
        },
      },
    );
    log(`backup written to ${backupPath}`);

    await stopServer(serverA);
    serverA = null;

    // -- wipe: a fresh db, never the shared one --------------------------------
    log(`creating fresh database ${RESTORE_DB}`);
    psql(`DROP DATABASE IF EXISTS ${RESTORE_DB}`);
    psql(`CREATE DATABASE ${RESTORE_DB}`);

    // -- restore ----------------------------------------------------------------
    log(`restoring into ${RESTORE_DB} / ${restoreDataDir}`);
    run(['bash', join(DEPLOY_DIR, 'restore.sh'), backupPath], {
      env: {
        PG_CONTAINER,
        POSTGRES_USER,
        POSTGRES_DB: RESTORE_DB,
        STORAGE: 'fs',
        DATA_DIR: restoreDataDir,
      },
    });

    // -- verify: run.ts's ten scenarios against the restored copy -------------
    log(`starting server B against ${RESTORE_DB} / ${restoreDataDir}`);
    serverB = spawnServer({
      DATABASE_URL: dbUrl(RESTORE_DB),
      AUTH_SECRET: process.env.AUTH_SECRET ?? 'backup-restore-test-secret',
      PORT,
      SERVER_ORIGIN,
      WEB_ORIGIN,
      DATA_DIR: restoreDataDir,
      STORAGE: 'fs',
    });
    await waitReady(SERVER_ORIGIN);
    log('server B ready; running e2e/src/run.ts against it');

    const proc = Bun.spawn(['bun', 'run', 'src/run.ts'], {
      cwd: E2E_DIR,
      env: {
        ...process.env,
        SERVER_ORIGIN,
        WEB_ORIGIN,
      } as Record<string, string>,
      stdout: 'inherit',
      stderr: 'inherit',
    });
    const exitCode = await proc.exited;

    if (exitCode === 0) {
      console.log(
        '\nbackup-restore: PASS (run.ts 10/10 against the restored copy)',
      );
    } else {
      console.log(
        `\nbackup-restore: FAIL (run.ts exited ${exitCode} against the restored copy)`,
      );
    }
    process.exitCode = exitCode;
  } finally {
    if (serverA) await stopServer(serverA);
    if (serverB) await stopServer(serverB);
    // Drop the restore target and its temp dir — the backup archive itself
    // is left under backupRoot for inspection (it's under the OS temp dir,
    // not the repo, so it doesn't linger in a working tree either way).
    try {
      psql(`DROP DATABASE IF EXISTS ${RESTORE_DB}`);
    } catch (err) {
      console.error('cleanup: drop restore db failed', err);
    }
    try {
      rmSync(restoreDataDir, { recursive: true, force: true });
    } catch (err) {
      console.error('cleanup: remove restore data dir failed', err);
    }
  }
}

main().catch((err) => {
  console.error(
    'backup-restore crashed:',
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
});
