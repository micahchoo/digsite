// docs/measurements/phase-5.md "After the leftovers", problem 1 — the
// coordinator's sharper repro: a real browser's initial viewport load
// fires many tile requests at once (not one worker looping sequentially,
// leak-pan.ts's own shape), and their destination tiles at coarse zooms
// (z=0/-1) overlap heavily in which S=128 ladder pages they need. This
// fires BURSTS of genuinely concurrent requests, immediately at cold
// start, biased to z=0/-1, to reproduce that shape directly.
//
//   PORT=8815 bun run scripts/cold-burst-pan.ts <boardId> <bursts> <burstSize>
import type { Zoom } from '@digsite/shared/board/grid';
import { CELL, perTileSide, worldExtent } from '@digsite/shared/board/grid';
import { pool } from '../src/db/pool.ts';
import { env } from '../src/env.ts';

const SERVER = env.SERVER_ORIGIN;
const MEMBER_EMAIL = 'member@example.test';
const MEMBER_PASSWORD = 'password1';
const COARSE_ZOOMS: Zoom[] = [0, -1]; // where this shape lives, per the coordinator's report

async function signIn(): Promise<string> {
  const res = await fetch(`${SERVER}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: SERVER },
    body: JSON.stringify({ email: MEMBER_EMAIL, password: MEMBER_PASSWORD }),
  });
  if (res.status !== 200) {
    throw new Error(`sign-in failed: ${res.status} ${await res.text()}`);
  }
  const cookie = res.headers.get('set-cookie')?.split(';')[0] ?? '';
  if (!cookie) throw new Error('sign-in carried no cookie');
  return cookie;
}

function tileGrid(count: number, z: Zoom): { nx: number; ny: number } {
  const [, , w, h] = worldExtent(count);
  const side = perTileSide(z) * CELL;
  return {
    nx: Math.max(1, Math.ceil(w / side)),
    ny: Math.max(1, Math.ceil(h / side)),
  };
}

async function boardImageCount(boardId: string): Promise<number> {
  const { rows } = await pool.query(
    'SELECT image_count FROM boards WHERE id = $1',
    [boardId],
  );
  if (rows.length === 0) throw new Error(`no board ${boardId}`);
  return rows[0].image_count as number;
}

function rssMB(): number {
  return Math.round(process.memoryUsage().rss / 1024 / 1024);
}

async function main() {
  const [boardId, burstsRaw, burstSizeRaw] = process.argv.slice(2);
  if (!boardId)
    throw new Error('usage: cold-burst-pan.ts <boardId> [bursts] [burstSize]');
  const bursts = Number(burstsRaw ?? 30);
  const burstSize = Number(burstSizeRaw ?? 40); // a real viewport's worth of tiles at once

  const count = await boardImageCount(boardId);
  const cookie = await signIn();
  console.log(
    `cold-burst-pan: board=${boardId} count=${count} bursts=${bursts} burstSize=${burstSize} server=${SERVER}`,
  );
  console.log(`t+0s rss=${rssMB()}MB (process start)`);

  let requests = 0;
  let errors = 0;
  const t0 = performance.now();
  for (let b = 0; b < bursts; b++) {
    const jobs: Promise<void>[] = [];
    for (let i = 0; i < burstSize; i++) {
      const z = COARSE_ZOOMS[i % COARSE_ZOOMS.length] as Zoom;
      const { nx, ny } = tileGrid(count, z);
      // Overlapping-window bias: most of one burst samples a small nx*ny
      // NEIGHBOURHOOD (like a real viewport), not the whole grid uniformly
      // — that's what makes many concurrent requests want the SAME ladder
      // pages at once.
      const cx = Math.floor(Math.random() * nx);
      const cy = Math.floor(Math.random() * ny);
      const x = Math.max(0, Math.min(nx - 1, cx + (Math.floor(i / 2) % 6) - 3));
      const y = Math.max(0, Math.min(ny - 1, cy + (i % 6) - 3));
      jobs.push(
        (async () => {
          try {
            const res = await fetch(
              `${SERVER}/boards/${boardId}/tiles/uploaded_at.desc/${z}/${x}/${y}.png`,
              { headers: { cookie } },
            );
            await res.arrayBuffer();
            requests++;
            if (res.status !== 200) errors++;
          } catch {
            errors++;
          }
        })(),
      );
    }
    await Promise.all(jobs);
    console.log(
      `t+${((performance.now() - t0) / 1000).toFixed(1)}s burst=${b + 1}/${bursts} requests=${requests} errors=${errors} rss=${rssMB()}MB`,
    );
  }

  console.log(
    JSON.stringify(
      { step: 'cold-burst-pan', requests, errors, finalRssMB: rssMB() },
      null,
      2,
    ),
  );
  await pool.end();
}

main().catch((err) => {
  console.error('cold-burst-pan failed:', err);
  process.exit(1);
});
