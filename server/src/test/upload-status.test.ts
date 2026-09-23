import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createCanvas } from '@napi-rs/canvas';
import { createHttpServer } from '../app.ts';
import { pool } from '../db/pool.ts';

let server: Server;
let base = '';
let cookie = '';
let boardId = '';
let privateBoardId = '';
let foreignImageId = '';
let ids: string[] = [];

async function post(path: string, body: unknown, authenticated = true) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      Origin: base,
      'Content-Type': 'application/json',
      cookie: authenticated ? cookie : '',
    },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  server = createHttpServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const auth = await post('/api/auth/sign-up/email', {
    email: `upload-status-${crypto.randomUUID()}@example.test`,
    password: 'password1234',
    name: 'Status tester',
  });
  cookie = auth.headers.get('set-cookie')?.split(';')[0] ?? '';
  expect(auth.status).toBe(200);
  const userId = ((await auth.json()) as { user: { id: string } }).user.id;
  const group = await post('/groups', { name: 'Upload status' });
  const groupId = ((await group.json()) as { id: string }).id;
  const board = await post(`/groups/${groupId}/boards`, {
    name: 'Bulk images',
    open: true,
  });
  boardId = ((await board.json()) as { id: string }).id;
  const other = await pool.query(
    "INSERT INTO boards (org_id,name,open,created_by) VALUES ($1,'Other board',false,$2) RETURNING id",
    [groupId, userId],
  );
  privateBoardId = other.rows[0].id;
  const foreign = await pool.query(
    "INSERT INTO images (board_id,slot,sha256,name,width,height,uploaded_by) VALUES ($1,0,'foreign','foreign.png',1,1,$2) RETURNING id",
    [privateBoardId, userId],
  );
  foreignImageId = foreign.rows[0].id;
  const inserted = await pool.query(
    `INSERT INTO images (board_id,slot,sha256,name,width,height,uploaded_by,status)
    SELECT $1,n,'test-' || n,'image-' || n,1,1,$2,CASE WHEN n=0 THEN 'failed' WHEN n=1 THEN 'pending' ELSE 'ready' END
    FROM generate_series(0,599) n RETURNING id,slot`,
    [boardId, userId],
  );
  ids = inserted.rows.sort((a, b) => a.slot - b.slot).map((row) => row.id);
  await pool.query('UPDATE boards SET image_count=600 WHERE id=$1', [boardId]);
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('checks old accepted IDs independently of the newest 500 and does not build ranks', async () => {
  const res = await post(`/boards/${boardId}/images/status`, {
    ids: [ids[0], ids[1], ids[599]],
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    images: [
      { id: ids[0], status: 'failed', error: null },
      { id: ids[1], status: 'pending', error: null },
      { id: ids[599], status: 'ready', error: null },
    ],
  });
  const ranks = await pool.query(
    'SELECT count(*)::int AS n FROM board_rank_state WHERE board_id=$1',
    [boardId],
  );
  expect(ranks.rows[0].n).toBe(0);
});

test('requires board access and never returns another board image', async () => {
  expect(
    (await post(`/boards/${boardId}/images/status`, { ids: [ids[0]] }, false))
      .status,
  ).toBe(401);
  expect(
    (await post(`/boards/${privateBoardId}/images/status`, { ids: [ids[0]] }))
      .status,
  ).toBe(403);
  const res = await post(`/boards/${boardId}/images/status`, {
    ids: [foreignImageId, crypto.randomUUID()],
  });
  expect(await res.json()).toEqual({ images: [] });
});

test('caps each lookup at 500 IDs and rejects malformed requests', async () => {
  for (const body of [
    null,
    { ids: ['invalid'] },
    { ids: ids.slice(0, 501) },
    { ids: 'bad' },
  ]) {
    expect((await post(`/boards/${boardId}/images/status`, body)).status).toBe(
      400,
    );
  }
  const res = await post(`/boards/${boardId}/images/status`, {
    ids: ids.slice(0, 500),
  });
  expect(res.status).toBe(200);
  expect(((await res.json()) as { images: unknown[] }).images.length).toBe(500);
});

test('resumable completion identifies the accepted image and logs its response', async () => {
  const bytes = createCanvas(2, 2).toBuffer('image/png');
  const logs: string[] = [];
  const log = console.log;
  console.log = (...values: unknown[]) => {
    logs.push(values.join(' '));
    log(...values);
  };
  try {
    const created = await fetch(`${base}/boards/${boardId}/uploads`, {
      method: 'POST',
      headers: {
        cookie,
        'Tus-Resumable': '1.0.0',
        'Upload-Length': String(bytes.length),
        'Upload-Metadata': `filename ${Buffer.from('status.png').toString('base64')}`,
      },
    });
    expect(created.status).toBe(201);
    const location = created.headers.get('Location');
    expect(location).toBeTruthy();
    const completed = await fetch(new URL(location ?? '', base), {
      method: 'PATCH',
      headers: {
        cookie,
        'Tus-Resumable': '1.0.0',
        'Upload-Offset': '0',
        'Content-Type': 'application/offset+octet-stream',
      },
      body: bytes,
    });
    expect(completed.status).toBe(204);
    const imageId = completed.headers.get('Upload-Image-Id');
    expect(imageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(completed.headers.get('Access-Control-Expose-Headers')).toContain(
      'Upload-Image-Id',
    );
    const status = await post(`/boards/${boardId}/images/status`, {
      ids: [imageId],
    });
    expect(await status.json()).toEqual({
      images: [{ id: imageId, status: 'pending', error: null }],
    });
    expect(
      logs.some(
        (line) =>
          line.includes('"route":"(tus)"') && line.includes('"method":"PATCH"'),
      ),
    ).toBe(true);
  } finally {
    console.log = log;
  }
});
