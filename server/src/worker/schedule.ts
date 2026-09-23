// Job scheduling: the one way anything puts work in `jobs`. Each kind
// declares here whether it coalesces, one pending job per board, and how
// long it waits for a burst to settle. A caller says what it wants, never
// how to spell it in SQL.
//
// Before this module, each coalescing kind had its own hand-written upsert,
// and picking the wrong one starved a board: GET /boards/:id used the
// debouncing upsert, so every read moved the pending arrangement another
// 30 s out and a watched board was never arranged.
//
// A coalescing kind needs its partial unique index (`ON jobs
// ((payload->>'boardId')) WHERE kind = '<kind>' AND state = 'pending'`);
// ON CONFLICT can only use it with the predicate written out literally,
// so the kind goes into the SQL, always from this table and never from
// input.
import { pool } from '../db/pool.ts';

type KindRule = { coalesce: null } | { coalesce: { settle: string } };

const KINDS = {
  ladder: { coalesce: null },
  embed: { coalesce: null },
  materialise: { coalesce: null },
  'folder-import': { coalesce: null },
  // 0003_phase1.sql: jobs_rank_rebuild_pending_board
  'rank-rebuild': { coalesce: { settle: '2 seconds' } },
  // 0025_meaning_pos.sql: jobs_arrange_pending_board
  arrange: { coalesce: { settle: '30 seconds' } },
} as const satisfies Record<string, KindRule>;

export type JobKind = keyof typeof KINDS;

/** `settle`: for a coalescing kind, wait for the burst: a pending job
 * moves its start out again. `soon`: make sure one is pending, due now,
 * and never move one that is. A kind that does not coalesce ignores it. */
export type ScheduleMode = 'settle' | 'soon';

export async function schedule(
  kind: JobKind,
  payload: Record<string, unknown>,
  mode: ScheduleMode = 'settle',
): Promise<void> {
  const rule: KindRule = KINDS[kind];
  if (!rule.coalesce) {
    await pool.query('INSERT INTO jobs (kind, payload) VALUES ($1, $2)', [
      kind,
      JSON.stringify(payload),
    ]);
    return;
  }
  if (typeof payload.boardId !== 'string') {
    throw new Error(`${kind} jobs coalesce per board and need a boardId`);
  }
  const wait = rule.coalesce.settle;
  const onConflict =
    mode === 'settle'
      ? `DO UPDATE SET run_after = now() + interval '${wait}'`
      : 'DO NOTHING';
  await pool.query(
    `INSERT INTO jobs (kind, payload, run_after)
     VALUES ($1, $2, now() + ${mode === 'settle' ? `interval '${wait}'` : "interval '0'"})
     ON CONFLICT ((payload->>'boardId'))
       WHERE kind = '${kind}' AND state = 'pending'
       ${onConflict}`,
    [kind, JSON.stringify(payload)],
  );
}

/** For worker/jobs.ts#runJob: a kind this module does not know is a bug
 * somewhere that wrote to `jobs` without it. */
export function isJobKind(kind: string): kind is JobKind {
  return Object.hasOwn(KINDS, kind);
}
