// docs/phases/1-map.md section 4 ("The scale run"). Creates or reuses a
// board in group "Lab" (owned by `member@example.test`, both from
// `bun run seed`) and grows it to `count` synthetic images: rows inserted
// by SQL in batches of 10,000, ladder pages painted by a pool of Bun
// workers (synth-worker.ts) using the same page format
// server/src/boards/ladder.ts writes for a real upload — see that file's
// header comment and .claude/rules/ladder-slot-vs-rank.md.
//
// It does NOT go through POST /boards/:id/images — a million HTTP uploads
// is not the thing phase 1 measures — but every row and page it writes is
// exactly what the upload path writes: same columns, same file names, same
// page layout, status 'ready' (docs/phases/1-map.md's synth.ts contract).
//
// Idempotent per board: a slot below the board's CURRENT image_count is
// never re-inserted, and a slot at or above the painted marker
// (`<DATA_DIR>/boards/<id>/synth-painted.json`) is never re-painted. A
// crash mid-run resumes: the next invocation with the same board/count
// first paints any inserted-but-unpainted tail, then continues growing.
//
// Usage:
//   bun run scripts/synth.ts --new "Synthetic 1M" 1000000
//   bun run scripts/synth.ts <boardId> 1000000   # idempotent re-run / resume / grow
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  LADDER,
  type LadderSize,
  ladderAddress,
} from '@digsite/shared/board/ladder';
import { pool } from '../src/db/pool.ts';
import { env } from '../src/env.ts';

const BATCH = 10_000;
const WORKER_COUNT = Math.max(
  1,
  Math.min(Number(process.env.SYNTH_WORKERS ?? 16), 32),
);

type PageJob = { size: LadderSize; page: number; slots: number[] };

function usage(): never {
  console.error(
    'usage: bun run scripts/synth.ts <boardId|--new "name"> <count>',
  );
  process.exit(1);
}

async function resolveBoard(
  boardArg: string,
  newName: string | null,
): Promise<{ boardId: string; imageCount: number }> {
  const lab = await pool.query(
    `SELECT id FROM organization WHERE name = 'Lab'`,
  );
  if (lab.rows.length === 0) {
    throw new Error(
      'group "Lab" not found — run `bun run seed` against a running server first',
    );
  }
  const labId = lab.rows[0].id as string;

  const member = await pool.query(
    `SELECT id FROM "user" WHERE email = 'member@example.test'`,
  );
  if (member.rows.length === 0) {
    throw new Error(
      'user "member@example.test" not found — run `bun run seed` first',
    );
  }
  const memberId = member.rows[0].id as string;

  if (newName !== null) {
    const existing = await pool.query(
      'SELECT id, image_count FROM boards WHERE org_id = $1 AND name = $2',
      [labId, newName],
    );
    if (existing.rows.length > 0) {
      console.log(
        `board "${newName}" already exists -> ${existing.rows[0].id}, reusing`,
      );
      return {
        boardId: existing.rows[0].id,
        imageCount: existing.rows[0].image_count,
      };
    }
    const created = await pool.query(
      `INSERT INTO boards (org_id, name, open, team_id, created_by)
       VALUES ($1, $2, true, null, $3) RETURNING id, image_count`,
      [labId, newName, memberId],
    );
    console.log(`created board "${newName}" -> ${created.rows[0].id}`);
    return {
      boardId: created.rows[0].id,
      imageCount: created.rows[0].image_count,
    };
  }

  const found = await pool.query(
    'SELECT id, image_count FROM boards WHERE id = $1',
    [boardArg],
  );
  if (found.rows.length === 0) {
    throw new Error(`no board with id ${boardArg}`);
  }
  return { boardId: found.rows[0].id, imageCount: found.rows[0].image_count };
}

function markerPath(boardId: string): string {
  return join(env.DATA_DIR, 'boards', boardId, 'synth-painted.json');
}

function readMarker(boardId: string): number {
  const path = markerPath(boardId);
  if (!existsSync(path)) return 0;
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    return typeof data.paintedUpTo === 'number' ? data.paintedUpTo : 0;
  } catch {
    return 0;
  }
}

function writeMarker(boardId: string, paintedUpTo: number): void {
  const path = markerPath(boardId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ paintedUpTo }));
}

/** One transaction: bump image_count by batchLen, insert the synthetic
 * rows for the reserved slot range. Mirrors upload.ts#uploadOne's
 * "slot from image_count, same transaction" shape, batched. Returns the
 * reserved start slot (from the UPDATE...RETURNING, so it is correct even
 * if something else also holds image_count open — nothing else should for
 * this board, but the query is honest about where the number comes from). */
async function insertBatch(
  boardId: string,
  memberId: string,
  batchLen: number,
): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const upd = await client.query(
      `UPDATE boards SET image_count = image_count + $2
       WHERE id = $1 RETURNING image_count - $2 AS start_slot`,
      [boardId, batchLen],
    );
    const startSlot = upd.rows[0].start_slot as number;
    await client.query(
      `INSERT INTO images
         (board_id, slot, sha256, name, width, height, uploaded_by, properties, status, uploaded_at)
       SELECT
         $1::uuid,
         ($3::int + gs) AS slot,
         'synthetic-' || ($3::int + gs)::text AS sha256,
         'img-' || substr(md5(($3::int + gs)::text), 1, 8) AS name,
         256, 256,
         $4::text AS uploaded_by,
         jsonb_build_object(
           'year', 1900 + (('x' || substr(md5(($3::int + gs)::text), 15, 4))::bit(16)::int % 126),
           'site', 'site-' || (($3::int + gs) % 40)
         ) AS properties,
         'ready' AS status,
         ('2020-01-01'::timestamptz +
           ((('x' || substr(md5(($3::int + gs)::text), 9, 6))::bit(24)::int % 2000000) * interval '1 minute')
         ) AS uploaded_at
       FROM generate_series(0, $2::int - 1) AS gs`,
      [boardId, batchLen, startSlot, memberId],
    );
    await client.query(
      'UPDATE board_rank_state SET stale = true WHERE board_id = $1',
      [boardId],
    );
    await client.query('COMMIT');
    return startSlot;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function buildPageJobs(startSlot: number, endSlot: number): PageJob[] {
  const bySize = new Map<LadderSize, Map<number, number[]>>();
  for (const s of LADDER) bySize.set(s, new Map());
  for (let slot = startSlot; slot < endSlot; slot++) {
    for (const s of LADDER) {
      const { page } = ladderAddress(slot, s);
      const m = bySize.get(s) as Map<number, number[]>;
      let list = m.get(page);
      if (!list) {
        list = [];
        m.set(page, list);
      }
      list.push(slot);
    }
  }
  const jobs: PageJob[] = [];
  for (const [size, pages] of bySize) {
    for (const [page, slots] of pages) jobs.push({ size, page, slots });
  }
  return jobs;
}

class WorkerPool {
  private workers: Worker[] = [];

  constructor(count: number) {
    const url = new URL('./synth-worker.ts', import.meta.url);
    for (let i = 0; i < count; i++) this.workers.push(new Worker(url));
  }

  /** Splits jobs round-robin across the pool and waits for every worker to
   * finish its share. Static partition, not work-stealing: with hundreds
   * of jobs per batch and a pool of 16-32, the imbalance is small and this
   * keeps the protocol trivial. */
  async run(boardId: string, jobs: PageJob[]): Promise<void> {
    if (jobs.length === 0) return;
    const shares: PageJob[][] = this.workers.map(() => []);
    jobs.forEach((job, i) => shares[i % this.workers.length]?.push(job));

    await Promise.all(
      this.workers.map(
        (w, i) =>
          new Promise<void>((resolve, reject) => {
            const share = shares[i] ?? [];
            if (share.length === 0) return resolve();
            const onMessage = () => {
              w.removeEventListener('message', onMessage);
              w.removeEventListener('error', onError);
              resolve();
            };
            const onError = (e: ErrorEvent) => {
              w.removeEventListener('message', onMessage);
              w.removeEventListener('error', onError);
              reject(e.error ?? e);
            };
            w.addEventListener('message', onMessage);
            w.addEventListener('error', onError);
            w.postMessage({ boardId, jobs: share });
          }),
      ),
    );
  }

  terminate(): void {
    for (const w of this.workers) w.terminate();
  }
}

async function paintRange(
  pool_: WorkerPool,
  boardId: string,
  start: number,
  end: number,
): Promise<void> {
  // Chunk the paint itself, independent of insert batching, so a resume
  // after a crash doesn't have to redo an enormous single range in one
  // in-memory job list.
  for (let s0 = start; s0 < end; s0 += BATCH) {
    const s1 = Math.min(end, s0 + BATCH);
    const jobs = buildPageJobs(s0, s1);
    await pool_.run(boardId, jobs);
    writeMarker(boardId, s1);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) usage();

  let boardArg = '';
  let newName: string | null = null;
  let countArg: string;
  if (args[0] === '--new') {
    if (args.length < 3) usage();
    newName = args[1] as string;
    countArg = args[2] as string;
  } else {
    boardArg = args[0] as string;
    countArg = args[1] as string;
  }
  const count = Number(countArg);
  if (!Number.isFinite(count) || count <= 0) usage();

  const t0 = performance.now();
  const { boardId, imageCount: existingCount } = await resolveBoard(
    boardArg,
    newName,
  );
  console.log(
    `board ${boardId}: image_count=${existingCount}, target=${count}`,
  );

  const member = await pool.query(
    `SELECT id FROM "user" WHERE email = 'member@example.test'`,
  );
  const memberId = member.rows[0].id as string;

  const wp = new WorkerPool(WORKER_COUNT);
  console.log(`worker pool: ${WORKER_COUNT} workers`);

  try {
    const paintedUpTo = readMarker(boardId);
    if (paintedUpTo < existingCount) {
      console.log(
        `resuming: painting inserted-but-unpainted slots [${paintedUpTo}, ${existingCount})`,
      );
      await paintRange(wp, boardId, paintedUpTo, existingCount);
    }

    if (existingCount >= count) {
      console.log(
        `board already has ${existingCount} images (>= requested ${count}); nothing to insert`,
      );
    } else {
      let cursor = existingCount;
      while (cursor < count) {
        const batchLen = Math.min(BATCH, count - cursor);
        const startSlot = await insertBatch(boardId, memberId, batchLen);
        await paintRange(wp, boardId, startSlot, startSlot + batchLen);
        cursor = startSlot + batchLen;
        const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
        console.log(
          `progress: ${cursor}/${count} images (${elapsed}s elapsed)`,
        );
      }
    }
  } finally {
    wp.terminate();
  }

  const totalMs = performance.now() - t0;
  console.log(
    `done: board ${boardId} has ${count} synthetic images. total ${(totalMs / 1000).toFixed(1)}s`,
  );
  await pool.end();
}

main().catch((err) => {
  console.error('synth failed:', err);
  process.exit(1);
});
