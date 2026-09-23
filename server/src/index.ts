// Bootstrap: build the app (app.ts), warm recently-viewed boards' default
// sort, listen, and start the worker. See docs/design.md "server/" and
// docs/phases/1-map.md "Upload as a worker". env.WORKER decides where it
// runs: a supervised child process by default (worker/supervisor.ts),
// inside this process with `inline`, or nowhere with `off`.
import { parseSortId } from '@digsite/shared/board/sort';
import { createHttpServer } from './app.ts';
import { listenForInvalidation } from './boards/invalidation.ts';
import { ensureRank } from './boards/ranks.ts';
import { pool } from './db/pool.ts';
import { env } from './env.ts';
import { startWorker } from './worker/index.ts';
import { superviseWorker } from './worker/supervisor.ts';

// Warm the default sort for boards viewed recently, so the first tile after
// a restart doesn't pay the rebuild — docs/design.md "ensureRank rebuilds
// lazily ... also warm the board's default sort at server start".
async function warmRecentBoards() {
  const { rows } = await pool.query(
    'SELECT id, default_sort FROM boards ORDER BY created_at DESC LIMIT 20',
  );
  for (const b of rows) {
    const sort = parseSortId(b.default_sort);
    if (!sort) continue;
    try {
      await ensureRank(b.id, sort);
    } catch (err) {
      console.error('warm rank failed', b.id, err);
    }
  }
}

const httpServer = createHttpServer();
// Phase 5 section 3 (docs/phases/5-hardening.md): `listen(port)` with no
// host binds every interface (`::`) — HOST (env.ts, 127.0.0.1 by default)
// closes that. Compose sets HOST=0.0.0.0 for the container, where the
// loopback isn't reachable from the `caddy` container.
httpServer.listen(env.PORT, env.HOST, () => {
  console.log(`digsite server on http://${env.HOST}:${env.PORT}`);
  warmRecentBoards().catch((err) => console.error('warm failed', err));
  listenForInvalidation();
  if (env.WORKER === 'inline') {
    startWorker();
    console.log('worker started in-process (bounded batches; idle poll 500ms)');
  } else if (env.WORKER === 'process') {
    const worker = superviseWorker();
    const shutdown = () => worker.stop().finally(() => process.exit(0));
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  }
});
