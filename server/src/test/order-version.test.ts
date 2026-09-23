import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// Roadmap item 7 and C3 over HTTP. A tile answers with its order build's
// token, and a URL that names that token is kept by the browser for good;
// one naming another build is never kept; one naming none keeps the old
// short cache. Every answer in ranks names the same token, and a
// selection by ranks from a build that has moved on is refused.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';
import { createHttpServer } from '../app.ts';
import { paintLadder } from '../boards/ladder.ts';
import { markBoardRanksStale } from '../boards/ranks.ts';
import { pool } from '../db/pool.ts';
import { env } from '../env.ts';
import { MODEL, toVectorText } from '../meaning/model.ts';

let server: Server;
let base = '';

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

let cookie = '';

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

async function boardWithOneImage(): Promise<string> {
  const ts = Date.now();
  await request('POST', '/api/auth/sign-up/email', {
    email: `tile-policy-${ts}@example.test`,
    password: 'password1234',
    name: 'owner',
  });
  const group = (await (
    await request('POST', '/groups', { name: `Tiles-${ts}` })
  ).json()) as { id: string };
  const board = (await (
    await request('POST', `/groups/${group.id}/boards`, {
      name: 'B',
      open: true,
    })
  ).json()) as { id: string };
  await pool.query(
    `INSERT INTO images (board_id, slot, sha256, name, width, height, uploaded_by, status)
     VALUES ($1, 0, $2, 'a.png', 16, 16, 'tester', 'ready')`,
    [board.id, `sha-tile-policy-${ts}`],
  );
  await pool.query('UPDATE boards SET image_count = 1 WHERE id = $1', [
    board.id,
  ]);
  const png = await sharp({
    create: { width: 16, height: 16, channels: 3, background: '#c33' },
  })
    .png()
    .toBuffer();
  await paintLadder(board.id, 0, png);
  return board.id;
}

describe('tile cache policy', () => {
  test("its own build's token is kept for good; another build's never; none, briefly", async () => {
    const boardId = await boardWithOneImage();
    const tile = `/boards/${boardId}/tiles/uploaded_at.desc/0/0/0.png`;

    const plain = await request('GET', tile);
    expect(plain.status).toBe(200);
    const token = plain.headers.get('x-order-version') ?? '';
    expect(token).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(plain.headers.get('cache-control')).toBe('private, max-age=60');
    expect(plain.headers.get('access-control-expose-headers')).toContain(
      'X-Order-Version',
    );

    const named = await request('GET', `${tile}?v=${token}`);
    expect(named.headers.get('cache-control')).toBe(
      'private, max-age=31536000, immutable',
    );

    // A new build: the old token now names pixels this server no longer
    // draws, so that URL must not be kept.
    await markBoardRanksStale(boardId);
    const old = await request('GET', `${tile}?v=${token}`);
    expect(old.headers.get('cache-control')).toBe('no-store');
    const next = old.headers.get('x-order-version');
    expect(next).not.toBe(token);
    const renamed = await request('GET', `${tile}?v=${next}`);
    expect(renamed.headers.get('cache-control')).toBe(
      'private, max-age=31536000, immutable',
    );
  });

  test('answers in ranks name the build; a selection from an old build is refused', async () => {
    const boardId = await boardWithOneImage();
    const tile = await request(
      'GET',
      `/boards/${boardId}/tiles/uploaded_at.desc/0/0/0.png`,
    );
    const token = tile.headers.get('x-order-version');
    for (const path of [
      `/boards/${boardId}/find?sort=uploaded_at.desc&q=a`,
      `/boards/${boardId}/sections?sort=uploaded_at.desc`,
      `/boards/${boardId}/images?sort=uploaded_at.desc&from=0&count=5`,
    ]) {
      const res = await request('GET', path);
      expect([path, res.status, res.headers.get('x-order-version')]).toEqual([
        path,
        200,
        token,
      ]);
    }

    const range = `/boards/${boardId}/selection/range`;
    const body = { sort: 'uploaded_at.desc', fromRank: 0, toRank: 0 };
    const current = await request('POST', range, { ...body, v: token });
    expect(current.status).toBe(200);
    expect(
      ((await current.json()) as { imageIds: string[] }).imageIds,
    ).toHaveLength(1);

    await markBoardRanksStale(boardId);
    const stale = await request('POST', range, { ...body, v: token });
    expect(stale.status).toBe(409);
    expect(stale.headers.get('x-order-version')).not.toBe(token);
    // Without `v` the old behaviour stands: resolved against the current build.
    expect((await request('POST', range, body)).status).toBe(200);
  });

  test('answers by meaning name the build too', async () => {
    const boardId = await boardWithOneImage();
    const { rows } = await pool.query(
      'SELECT id FROM images WHERE board_id = $1',
      [boardId],
    );
    const imageId = rows[0].id as string;
    const vector = new Float32Array(512);
    vector[0] = 1;
    await pool.query(
      `INSERT INTO image_embeddings (image_id, model, board_id, slot, embedding)
       VALUES ($1, $2, $3, 0, $4::halfvec)`,
      [imageId, MODEL, boardId, toVectorText(vector)],
    );
    const tile = await request(
      'GET',
      `/boards/${boardId}/tiles/uploaded_at.desc/0/0/0.png`,
    );
    const token = tile.headers.get('x-order-version');
    const embeddings = env.EMBEDDINGS;
    env.EMBEDDINGS = true;
    try {
      for (const route of ['similar', 'duplicates']) {
        const res = await request(
          'GET',
          `/boards/${boardId}/${route}?image=${imageId}&sort=uploaded_at.desc`,
        );
        expect([route, res.status, res.headers.get('x-order-version')]).toEqual(
          [route, 200, token],
        );
      }
    } finally {
      env.EMBEDDINGS = embeddings;
    }
  });
});
