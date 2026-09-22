// docs/measurements/phase-5.md "After the leftovers", problem 3: drops
// board_ranks + board_rank_state for every (board, sort) nobody has
// requested in N days — ranks.ts#sweepStaleRanks does the work, this is
// the operator entry point (a cron job, or run by hand). No server needed —
// same reasoning as synth.ts and load-boards.ts's build/cleanup.
//
//   bun run scripts/sweep-ranks.ts <olderThanDays>
//
// Default 30 days if not given. Safe to run at any time and at any
// frequency: a swept (board, sort) rebuilds transparently on its next
// request (ensureRank), the same path a `stale` one already takes.
import { sweepStaleRanks } from '../src/boards/ranks.ts';
import { pool } from '../src/db/pool.ts';

async function main() {
  const olderThanDays = Number(process.argv[2] ?? 30);
  if (!Number.isFinite(olderThanDays) || olderThanDays < 0) {
    throw new Error(
      `usage: sweep-ranks.ts <olderThanDays>, got ${process.argv[2]}`,
    );
  }
  const t0 = performance.now();
  const result = await sweepStaleRanks(olderThanDays);
  const ms = performance.now() - t0;
  console.log(
    JSON.stringify({ olderThanDays, ...result, ms: Math.round(ms) }, null, 2),
  );
  await pool.end();
}

main().catch((err) => {
  console.error('sweep-ranks failed:', err);
  process.exit(1);
});
