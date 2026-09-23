import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// Roadmap item 7 over HTTP: a tile answers with its order build's token,
// and a URL that names that token is kept by the browser for good. A URL
// naming another build is never kept; a URL naming none keeps the old
// short cache.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';
import { createHttpServer } from '../app.ts';
import { paintLadder } from '../boards/ladder.ts';
import { markBoardRanksStale } from '../boards/ranks.ts';
import { pool } from '../db/pool.ts';

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
});
