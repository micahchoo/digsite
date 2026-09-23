// Runs worker/main.ts as a child of the server and starts a new one whenever
// it exits — on purpose (it retires past its memory or job bound), or not
// (a crash, the kernel's OOM killer). The API keeps serving through either.
//
// Exit 0 is a retirement (worker/main.ts): the replacement starts at once,
// however short the life. Anything else is a crash; a crash within
// FAST_EXIT_MS of starting backs off, doubling to MAX_BACKOFF_MS, so a
// worker that cannot start does not spin.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MAIN = join(import.meta.dir, 'main.ts');
const FAST_EXIT_MS = 5_000;
const FIRST_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;

/** The server's one supervised worker, for GET /metrics. Null when the
 * worker runs inline, elsewhere, or not at all. */
let supervised: SupervisedWorker | null = null;

export function supervisedWorker(): SupervisedWorker | null {
  return supervised;
}

/** Resident memory of a live process, from /proc; null where there is none. */
export function rssBytes(pid: number): number | null {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const kb = status.match(/VmRSS:\s+(\d+)/)?.[1];
    return kb ? Number(kb) * 1024 : null;
  } catch {
    return null;
  }
}

export type SupervisedWorker = {
  /** The running child's pid, or null between restarts. */
  pid(): number | null;
  /** How many children have exited so far. */
  exits(): number;
  /** How many of those exits were not retirements. */
  crashes(): number;
  stop(): Promise<void>;
};

export function superviseWorker(
  env: Record<string, string | undefined> = process.env,
): SupervisedWorker {
  let child: Bun.Subprocess | null = null;
  let stopping = false;
  let exits = 0;
  let crashes = 0;
  let backoff = FIRST_BACKOFF_MS;
  let restart: ReturnType<typeof setTimeout> | null = null;

  const start = () => {
    restart = null;
    const startedAt = Date.now();
    const proc = Bun.spawn(['bun', 'run', MAIN], {
      env: { ...env, DIGSITE_SUPERVISED: '1' },
      stdout: 'inherit',
      stderr: 'inherit',
    });
    child = proc;
    proc.exited.then((code) => {
      exits++;
      if (code !== 0) crashes++;
      child = null;
      if (stopping) return;
      const lived = Date.now() - startedAt;
      const failing = code !== 0 && lived < FAST_EXIT_MS;
      const delay = failing ? backoff : 0;
      backoff = failing
        ? Math.min(backoff * 2, MAX_BACKOFF_MS)
        : FIRST_BACKOFF_MS;
      console.log(
        `[supervisor] worker ${proc.pid} exited ${code ?? proc.signalCode} after ${Math.round(lived / 1000)} s; restarting in ${delay} ms`,
      );
      restart = setTimeout(start, delay);
    });
  };

  start();
  const handle: SupervisedWorker = {
    pid: () => child?.pid ?? null,
    exits: () => exits,
    crashes: () => crashes,
    async stop() {
      stopping = true;
      if (supervised === handle) supervised = null;
      if (restart) clearTimeout(restart);
      const running = child;
      if (!running) return;
      running.kill('SIGTERM');
      await running.exited;
    },
  };
  supervised = handle;
  return handle;
}
