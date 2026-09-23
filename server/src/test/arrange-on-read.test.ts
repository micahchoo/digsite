import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// GET /boards/:id and the meaning arrangement: reading a board whose
// pictures are embedded but not placed makes sure an arrangement is
// queued, and never postpones it. Before, every read moved the job 30 s
// out, so a board polled every 3 s was never arranged (walk claim 16).
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHttpServer } from '../app.ts';
import { pool } from '../db/pool.ts';
import { env } from '../env.ts';
import { MODEL, toVectorText } from '../meaning/model.ts';

let server: Server;
let base = '';
let cookie = '';

beforeAll(async () => {
  server = createHttpServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(
  () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
);

async function request(method: string, path: string, json?: unknown) {
  const headers: Record<string, string> = { Origin: base };
  if (cookie) headers.cookie = cookie;
  if (json !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0] ?? '';
  return res;
}

describe('arrangement on read', () => {
  test('reading the board queues one arrangement and never moves it', async () => {
    const ts = Date.now();
    await request('POST', '/api/auth/sign-up/email', {
      email: `arrange-read-${ts}@example.test`,
      password: 'password1234',
      name: 'owner',
    });
    const group = (await (
      await request('POST', '/groups', { name: `Arrange-${ts}` })
    ).json()) as { id: string };
    const board = (await (
      await request('POST', `/groups/${group.id}/boards`, {
        name: 'B',
        open: true,
      })
    ).json()) as { id: string };
    const { rows } = await pool.query(
      `INSERT INTO images (board_id, slot, sha256, name, width, height, uploaded_by, status)
       VALUES ($1, 0, $2, 'a.png', 16, 16, 'tester', 'ready') RETURNING id`,
      [board.id, `sha-arrange-read-${ts}`],
    );
    const vector = new Float32Array(512);
    vector[0] = 1;
    await pool.query(
      `INSERT INTO image_embeddings (image_id, model, board_id, slot, embedding)
       VALUES ($1, $2, $3, 0, $4::halfvec)`,
      [rows[0].id, MODEL, board.id, toVectorText(vector)],
    );
    const runAfter = async () =>
      (
        await pool.query(
          `SELECT run_after FROM jobs
           WHERE kind = 'arrange' AND state = 'pending' AND payload->>'boardId' = $1`,
          [board.id],
        )
      ).rows.map((r) => (r.run_after as Date).getTime());

    const embeddings = env.EMBEDDINGS;
    env.EMBEDDINGS = true;
    try {
      const first = await request('GET', `/boards/${board.id}`);
      const body = (await first.json()) as { meaningUnplaced?: number };
      expect(body.meaningUnplaced).toBe(1);
      const queued = await runAfter();
      expect(queued).toHaveLength(1);
      for (let i = 0; i < 3; i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        await request('GET', `/boards/${board.id}`);
      }
      expect(await runAfter()).toEqual(queued);
    } finally {
      env.EMBEDDINGS = embeddings;
      await pool.query(
        `DELETE FROM jobs WHERE kind = 'arrange' AND payload->>'boardId' = $1`,
        [board.id],
      );
    }
  });
});
