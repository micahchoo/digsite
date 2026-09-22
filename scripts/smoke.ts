#!/usr/bin/env bun
// docs/phases/5-hardening.md section 6: runs the five web/scripts/smoke*.ts
// definition-of-done scripts (web/README.md), each against its own fresh
// stub (web/stub/server.ts) and its own vite dev server, on ports picked
// free at runtime — never the owner's dev instances at 8800/5180. A fresh
// stub per script because several of them mutate stub-global state
// (board/sheet delete, new sheets from an explore) and are only guaranteed
// self-contained against a stub nothing else has touched yet.
//
// `bun run smoke` at the repo root. Exits nonzero if any script fails.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findFreePort, waitUp } from './net.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..'); // scripts -> app
const WEB_DIR = join(REPO_ROOT, 'web');

const SERVER_PORT_BASE = 8850;
const WEB_PORT_BASE = 5250;
const FORBIDDEN_PORTS = new Set([8800, 5180]); // the owner's demo — never these

// web/scripts/smoke.ts itself is the phase-2 "sheet.png" / copyForeign
// script; the others each cover a later phase's own section — see each
// file's own header comment.
const SCRIPTS = [
  'scripts/smoke.ts',
  'scripts/smoke-board.ts',
  'scripts/smoke-draw.ts',
  'scripts/smoke-explore.ts',
  'scripts/smoke-groups.ts',
];

function log(msg: string): void {
  console.log(`[smoke] ${msg}`);
}

async function stopProc(proc: Bun.Subprocess | null): Promise<void> {
  if (!proc) return;
  proc.kill();
  await proc.exited;
}

async function runOne(script: string): Promise<boolean> {
  const serverPort = await findFreePort(SERVER_PORT_BASE, FORBIDDEN_PORTS);
  const webPort = await findFreePort(WEB_PORT_BASE, FORBIDDEN_PORTS);
  const serverOrigin = `http://localhost:${serverPort}`;
  const webOrigin = `http://localhost:${webPort}`;

  log(`${script}: stub=${serverOrigin} web=${webOrigin}`);

  let stubProc: Bun.Subprocess | null = null;
  let webProc: Bun.Subprocess | null = null;
  try {
    stubProc = Bun.spawn(['bun', 'run', 'stub/server.ts'], {
      cwd: WEB_DIR,
      env: {
        ...process.env,
        PORT: String(serverPort),
        WEB_ORIGIN: webOrigin,
      } as Record<string, string>,
      stdout: 'inherit',
      stderr: 'inherit',
    });
    await waitUp(serverOrigin);

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

    const res = Bun.spawnSync(['bun', 'run', script], {
      cwd: WEB_DIR,
      env: {
        ...process.env,
        SERVER_ORIGIN: serverOrigin,
        WEB_ORIGIN: webOrigin,
      } as Record<string, string>,
      stdout: 'inherit',
      stderr: 'inherit',
    });
    return res.exitCode === 0;
  } finally {
    await stopProc(webProc);
    await stopProc(stubProc);
  }
}

async function main() {
  const results: { script: string; pass: boolean }[] = [];
  for (const script of SCRIPTS) {
    const pass = await runOne(script);
    results.push({ script, pass });
    log(`${script}: ${pass ? 'PASS' : 'FAIL'}`);
  }
  console.log('');
  const failed = results.filter((r) => !r.pass);
  console.log(
    `${results.length - failed.length}/${results.length} smoke scripts passed`,
  );
  if (failed.length) {
    console.log(`FAILED: ${failed.map((r) => r.script).join(', ')}`);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('smoke crashed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
