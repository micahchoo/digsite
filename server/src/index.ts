// Bootstrap: build the app (app.ts), warm recently-viewed boards' default
// sort, listen. See docs/design.md "server/".
import { parseSortId } from '@digsite/shared/board/sort';
import { createHttpServer } from './app.ts';
import { ensureRank } from './boards/ranks.ts';
import { pool } from './db/pool.ts';
import { env } from './env.ts';

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
httpServer.listen(env.PORT, () => {
  console.log(`digsite server on http://localhost:${env.PORT}`);
  warmRecentBoards().catch((err) => console.error('warm failed', err));
});
