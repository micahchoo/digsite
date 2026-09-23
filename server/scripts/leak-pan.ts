// docs/measurements/phase-5.md "After the leftovers", problem 1 (the leak).
// A scripted pan over one board for a fixed duration — the same tile-walk
// shape as measure-map.ts's `tiles` subcommand (random z/x/y, signed in as
// the seeded member), but continuous rather than a fixed 500-per-zoom
// sample, so an operator can point RSS/metrics sampling at a real server
// process for the full window the brief asks for. No RSS/metrics reading in
// here on purpose — that's read from OUTSIDE this process (the server's own
// PID, `/metrics`), never from the client driving the requests.
//
//   PORT=8815 bun run scripts/leak-pan.ts <boardId> <durationMs> [concurrency]
import { ZOOMS, type Zoom } from '@digsite/shared/board/grid';
import { CELL, perTileSide, worldExtent } from '@digsite/shared/board/grid';
import { pool } from '../src/db/pool.ts';
import { env } from '../src/env.ts';

const SERVER = env.SERVER_ORIGIN;
// see measure-map.ts's own comment on this account; a database seeded by
// src/seed.ts uses password1234, so both are overridable.
const MEMBER_EMAIL = process.env.PAN_EMAIL ?? 'member@example.test';
const MEMBER_PASSWORD = process.env.PAN_PASSWORD ?? 'password1';

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

async function panLoop(
  cookie: string,
  boardId: string,
  count: number,
  deadline: number,
  stats: { requests: number; errors: number },
): Promise<void> {
  while (Date.now() < deadline) {
    const z = ZOOMS[Math.floor(Math.random() * ZOOMS.length)] as Zoom;
    const { nx, ny } = tileGrid(count, z);
    const x = Math.floor(Math.random() * nx);
    const y = Math.floor(Math.random() * ny);
    try {
      const res = await fetch(
        `${SERVER}/boards/${boardId}/tiles/uploaded_at.desc/${z}/${x}/${y}.png`,
        { headers: { cookie } },
      );
      await res.arrayBuffer();
      stats.requests++;
      if (res.status !== 200) stats.errors++;
    } catch {
      stats.errors++;
    }
  }
}

async function main() {
  const [boardId, durationMsRaw, concurrencyRaw] = process.argv.slice(2);
  if (!boardId)
    throw new Error('usage: leak-pan.ts <boardId> <durationMs> [concurrency]');
  const durationMs = Number(durationMsRaw ?? 15 * 60 * 1000);
  const concurrency = Number(concurrencyRaw ?? 8);

  const count = await boardImageCount(boardId);
  const cookie = await signIn();
  console.log(
    `leak-pan: board=${boardId} count=${count} durationMs=${durationMs} concurrency=${concurrency} server=${SERVER}`,
  );

  const stats = { requests: 0, errors: 0 };
  const deadline = Date.now() + durationMs;
  const progressTimer = setInterval(() => {
    console.log(
      `[leak-pan] t+${Math.round((Date.now() - (deadline - durationMs)) / 1000)}s requests=${stats.requests} errors=${stats.errors}`,
    );
  }, 10_000);

  await Promise.all(
    Array.from({ length: concurrency }, () =>
      panLoop(cookie, boardId, count, deadline, stats),
    ),
  );

  clearInterval(progressTimer);
  console.log(JSON.stringify({ step: 'leak-pan', ...stats }, null, 2));
  await pool.end();
}

main().catch((err) => {
  console.error('leak-pan failed:', err);
  process.exit(1);
});
