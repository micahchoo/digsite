// Free-port picking and "is it up yet" polling shared by scripts/e2e-fresh.ts
// and scripts/smoke.ts — both spawn a server and a web dev server on ports
// chosen at runtime rather than the owner's fixed dev ports (8800/5180).
import { createServer as createNetServer } from 'node:net';

function isFreePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createNetServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

/** The first free TCP port at or above `start`, skipping anything in
 * `forbidden` (the owner's own dev ports). Scans up to 1000 ports past
 * `start` before giving up. */
export async function findFreePort(
  start: number,
  forbidden: ReadonlySet<number> = new Set(),
): Promise<number> {
  let port = start;
  while (port < start + 1000) {
    if (!forbidden.has(port) && (await isFreePort(port))) return port;
    port++;
  }
  throw new Error(`no free port found starting at ${start}`);
}

/** Polls `origin` until it answers anything under 500 (a 404 counts — the
 * point is "something is listening", not "this route exists"). Used for the
 * web dev server and the web/stub, which have no readiness endpoint of
 * their own (unlike the real server's GET /readyz — see
 * scripts/e2e-fresh.ts's own waitReady). */
export async function waitUp(
  origin: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(origin);
      if (res.status < 500) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      throw new Error(`${origin} not up within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}
