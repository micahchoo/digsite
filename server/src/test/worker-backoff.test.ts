import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'node:http';
// Phase 5 section 4 (docs/phases/5-hardening.md "Operability", the worker
// bullet): exponential backoff (1s, 10s, 60s) for a failure that is NOT a
// decode error, dead-lettered (state='failed', last_error kept) on the
// fourth attempt, listed by GET /boards/:id/jobs?state=failed and
// resettable by POST /jobs/:id/retry — both under boardForManagingAllowlist
// (boards/routes.ts). worker.test.ts already covers the OTHER failure
// shape (a decode error: three attempts, no delay, unchanged by this
// phase) — this file is the new path.
//
// run_after is asserted with loose bounds and forced back to `now()`
// between polls (real waits of up to 60s would make this test untenable);
// the bounds are wide enough to absorb CI jitter while still being
// meaningfully different between the three backoff steps.
import type { AddressInfo } from 'node:net';
import { createCanvas } from '@napi-rs/canvas';
import { createHttpServer } from '../app.ts';
import { originalKey } from '../boards/paths.ts';
import { pool } from '../db/pool.ts';
import { storageFromEnv } from '../storage/index.ts';
import { drain, pollOnce } from '../worker/index.ts';

function onePixelPng(): Buffer {
  const canvas = createCanvas(4, 4);
  canvas.getContext('2d').fillRect(0, 0, 4, 4);
  return canvas.encodeSync('png');
}

async function jobRow(jobId: number) {
  const { rows } = await pool.query(
    'SELECT state, attempts, last_error, run_after FROM jobs WHERE id = $1',
    [jobId],
  );
  return rows[0] as {
    state: string;
    attempts: number;
    last_error: string | null;
    run_after: Date;
  };
}

async function forceDue(jobId: number): Promise<void> {
  await pool.query('UPDATE jobs SET run_after = now() WHERE id = $1', [jobId]);
}

function msFromNow(d: Date): number {
  return d.getTime() - Date.now();
}

describe('worker: backoff and dead-letter (non-decode failure)', () => {
  let server: Server;
  let base = '';
  let cookie = '';
  let boardId: string;
  let imageId: string;
  let jobId: number;
  let sha256: string;

  beforeAll(async () => {
    server = createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address() as AddressInfo;
    base = `http://127.0.0.1:${addr.port}`;

    const ts = Date.now();
    const signUp = await fetch(`${base}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `backoff-${ts}@example.test`,
        password: 'password1234',
        name: 'backoff',
      }),
    });
    const setCookie = signUp.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0] ?? '';

    const group = await fetch(`${base}/groups`, {
      method: 'POST',
      headers: { Origin: base, cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `Backoff-${ts}` }),
    });
    const groupId = ((await group.json()) as { id: string }).id;
    const board = await fetch(`${base}/groups/${groupId}/boards`, {
      method: 'POST',
      headers: { Origin: base, cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'B', open: true }),
    });
    boardId = ((await board.json()) as { id: string }).id;

    const form = new FormData();
    form.append(
      'files',
      new Blob([onePixelPng()], { type: 'image/png' }),
      'a.png',
    );
    const upload = await fetch(`${base}/boards/${boardId}/images?wait=0`, {
      method: 'POST',
      headers: { Origin: base, cookie },
      body: form,
    });
    imageId = ((await upload.json()) as { id: string }[])[0]?.id ?? '';
    if (!imageId) throw new Error('fixture upload returned no image');

    const { rows: imgRows } = await pool.query(
      'SELECT sha256 FROM images WHERE id = $1',
      [imageId],
    );
    sha256 = imgRows[0].sha256;

    // The bytes are gone by the time the worker runs — runLadderJob throws
    // a plain Error('original missing: ...'), NOT a DecodeError, which is
    // exactly the "not a decode error" shape this section's backoff is
    // for (worker/jobs.ts's comment on the distinction).
    await storageFromEnv().delete(originalKey(boardId, sha256));

    const { rows: jobRows } = await pool.query(
      `SELECT id FROM jobs WHERE kind = 'ladder' AND payload->>'imageId' = $1`,
      [imageId],
    );
    jobId = jobRows[0]?.id;
    if (jobId === undefined) throw new Error('fixture enqueued no ladder job');
  });

  afterAll(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );

  test('three backoff steps (~1s, ~10s, ~60s), then dead-letter with last_error kept', async () => {
    await pollOnce();
    let row = await jobRow(jobId);
    expect(row.state).toBe('pending');
    expect(row.attempts).toBe(1);
    expect(row.last_error).toContain('original missing');
    expect(msFromNow(row.run_after)).toBeGreaterThan(500);
    expect(msFromNow(row.run_after)).toBeLessThan(5_000);
    await forceDue(jobId);

    await pollOnce();
    row = await jobRow(jobId);
    expect(row.state).toBe('pending');
    expect(row.attempts).toBe(2);
    expect(msFromNow(row.run_after)).toBeGreaterThan(5_000);
    expect(msFromNow(row.run_after)).toBeLessThan(20_000);
    await forceDue(jobId);

    await pollOnce();
    row = await jobRow(jobId);
    expect(row.state).toBe('pending');
    expect(row.attempts).toBe(3);
    expect(msFromNow(row.run_after)).toBeGreaterThan(30_000);
    expect(msFromNow(row.run_after)).toBeLessThan(90_000);
    await forceDue(jobId);

    await pollOnce();
    row = await jobRow(jobId);
    expect(row.state).toBe('failed');
    expect(row.attempts).toBe(4);
    expect(row.last_error).toContain('original missing');
  });

  test('GET /boards/:id/jobs?state=failed lists it, under boardForManagingAllowlist', async () => {
    const res = await fetch(`${base}/boards/${boardId}/jobs?state=failed`, {
      headers: { Origin: base, cookie },
    });
    expect(res.status).toBe(200);
    const jobs = (await res.json()) as {
      id: number;
      kind: string;
      state: string;
      error: string | null;
    }[];
    const found = jobs.find((j) => j.id === jobId);
    expect(found).toBeTruthy();
    expect(found?.kind).toBe('ladder');
    expect(found?.state).toBe('failed');
    expect(found?.error).toContain('original missing');
  });

  test('POST /jobs/:id/retry resets it, and the retried job succeeds once the original is back', async () => {
    const retry = await fetch(`${base}/jobs/${jobId}/retry`, {
      method: 'POST',
      headers: { Origin: base, cookie },
    });
    expect(retry.status).toBe(200);

    const row = await jobRow(jobId);
    expect(row.state).toBe('pending');
    expect(row.attempts).toBe(0);
    expect(row.last_error).toBeNull();
    expect(msFromNow(row.run_after)).toBeLessThan(1_000); // due now, not backed off

    // Put the original back — this time the ladder job should actually
    // succeed, proving the retry route re-runs real work, not just a flag.
    await storageFromEnv().put(
      originalKey(boardId, sha256),
      onePixelPng(),
      'image/png',
    );
    await drain();

    const { rows } = await pool.query(
      'SELECT status FROM images WHERE id = $1',
      [imageId],
    );
    expect(rows[0].status).toBe('ready');

    const failedAfter = await fetch(
      `${base}/boards/${boardId}/jobs?state=failed`,
      {
        headers: { Origin: base, cookie },
      },
    );
    const stillFailed = (await failedAfter.json()) as { id: number }[];
    expect(stillFailed.some((j) => j.id === jobId)).toBe(false);
  });

  test('POST /jobs/:id/retry on a non-failed job refuses 400', async () => {
    // 'materialise' rather than 'rank-rebuild': the latter has a partial
    // unique index on (boardId, state='pending')
    // (jobs_rank_rebuild_pending_board, 0003_phase1.sql) that the
    // previous test's successful retry-and-drain may already have filled
    // via its own debounced rank-rebuild — a fresh materialise row has no
    // such constraint to collide with.
    const { rows } = await pool.query(
      "INSERT INTO jobs (kind, payload) VALUES ('materialise', jsonb_build_object('boardId', $1::text)) RETURNING id",
      [boardId],
    );
    const pendingJobId = rows[0].id;
    const res = await fetch(`${base}/jobs/${pendingJobId}/retry`, {
      method: 'POST',
      headers: { Origin: base, cookie },
    });
    expect(res.status).toBe(400);
    await pool.query('DELETE FROM jobs WHERE id = $1', [pendingJobId]);
  });
});
