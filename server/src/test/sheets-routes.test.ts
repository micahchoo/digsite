// docs/phases/2-sheet.md section 6 + section 4: GET /boards/:id/sheets'
// imageCount/savedAt, PATCH /sheets/:id under sheetForEditing, and
// POST /boards/:id/sheets honouring explicit `positions`. HTTP round trip
// through a real session, same approach as access.test.ts (Better Auth's
// sign-up/organization flow is awkward to fake) — images are inserted
// directly via SQL, same as snapshot.test.ts, since the upload pipeline is
// not this file's concern.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHttpServer } from '../app.ts';
import { pool } from '../db/pool.ts';

let server: Server;
let base = '';

beforeAll(async () => {
  server = createHttpServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(
  () =>
    new Promise<void>((resolve) => {
      // fetch's keep-alive sockets otherwise hold `close()` open past the
      // default 5s hook timeout (node's own default keepAliveTimeout) —
      // this file makes many more requests per test than access.test.ts,
      // so it hits that race where the older test happened not to.
      server.closeAllConnections();
      server.close(() => resolve());
    }),
);

class Session {
  cookie = '';

  private async raw(
    method: string,
    path: string,
    init: { json?: unknown } = {},
  ): Promise<{ status: number; json: unknown }> {
    const headers: Record<string, string> = { Origin: base };
    if (this.cookie) headers.cookie = this.cookie;
    let body: string | undefined;
    if (init.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(init.json);
    }
    const res = await fetch(`${base}${path}`, { method, headers, body });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0] ?? '';
    const text = await res.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
    }
    return { status: res.status, json };
  }

  get(path: string) {
    return this.raw('GET', path);
  }
  post(path: string, json?: unknown) {
    return this.raw('POST', path, { json });
  }
  patch(path: string, json?: unknown) {
    return this.raw('PATCH', path, { json });
  }
}

function withId(json: unknown): { id: string } {
  return json as { id: string };
}

async function signUpOrIn(email: string, name: string): Promise<Session> {
  const s = new Session();
  const up = await s.post('/api/auth/sign-up/email', {
    email,
    password: 'password1',
    name,
  });
  if (up.status === 200) return s;
  const inn = await s.post('/api/auth/sign-in/email', {
    email,
    password: 'password1',
  });
  if (inn.status !== 200) {
    throw new Error(`sign-in failed ${email}: ${inn.status}`);
  }
  return s;
}

async function makeImage(boardId: string, slot: number, name: string) {
  const { rows } = await pool.query(
    `INSERT INTO images (board_id, slot, sha256, name, width, height, uploaded_by)
     VALUES ($1,$2,$3,$4,200,100,'tester') RETURNING id, width, height`,
    [boardId, slot, `sha-sr-${slot}-${Date.now()}-${Math.random()}`, name],
  );
  return rows[0] as { id: string; width: number; height: number };
}

describe('sheets routes', () => {
  test('GET /boards/:id/sheets reports imageCount and savedAt (null with no snapshot)', async () => {
    const ts = Date.now();
    const owner = await signUpOrIn(`sr-owner-${ts}@example.test`, 'owner');
    const group = withId(
      (await owner.post('/groups', { name: `SR-${ts}` })).json,
    );
    const board = withId(
      (
        await owner.post(`/groups/${group.id}/boards`, {
          name: 'B',
          open: true,
        })
      ).json,
    );

    const imgA = await makeImage(board.id, 0, 'a');
    const imgB = await makeImage(board.id, 1, 'b');

    const created = await owner.post(`/boards/${board.id}/sheets`, {
      name: 'With snapshot',
      imageIds: [imgA.id, imgB.id],
    });
    expect(created.status).toBe(200);

    // A sheet with no snapshot at all: inserted directly, bypassing the
    // create route (which always writes an initial snapshot).
    const { rows: bareRows } = await pool.query(
      `INSERT INTO sheets (board_id, name, created_by) VALUES ($1,'Bare','tester') RETURNING id`,
      [board.id],
    );
    const bareId = bareRows[0].id;
    await pool.query(
      'INSERT INTO sheet_images (sheet_id, image_id) VALUES ($1,$2)',
      [bareId, imgA.id],
    );

    const list = await owner.get(`/boards/${board.id}/sheets`);
    expect(list.status).toBe(200);
    const sheets = list.json as {
      id: string;
      name: string;
      imageCount: number;
      savedAt: string | null;
    }[];

    const withSnapshot = sheets.find((s) => s.name === 'With snapshot');
    expect(withSnapshot?.imageCount).toBe(2);
    expect(typeof withSnapshot?.savedAt).toBe('string');

    const bare = sheets.find((s) => s.id === bareId);
    expect(bare?.imageCount).toBe(1);
    expect(bare?.savedAt).toBeNull();
  });

  test('PATCH /sheets/:id renames under sheetForEditing, refused for an outsider', async () => {
    const ts = Date.now();
    const owner = await signUpOrIn(`sr-rn-owner-${ts}@example.test`, 'owner');
    const group = withId(
      (await owner.post('/groups', { name: `SR-RN-${ts}` })).json,
    );
    const board = withId(
      (
        await owner.post(`/groups/${group.id}/boards`, {
          name: 'B',
          open: true,
        })
      ).json,
    );
    const img = await makeImage(board.id, 0, 'a');
    const sheet = withId(
      (
        await owner.post(`/boards/${board.id}/sheets`, {
          name: 'Original',
          imageIds: [img.id],
        })
      ).json,
    );

    const renamed = await owner.patch(`/sheets/${sheet.id}`, {
      name: 'Renamed',
    });
    expect(renamed.status).toBe(200);
    expect(renamed.json).toEqual({ name: 'Renamed' });

    const get = await owner.get(`/sheets/${sheet.id}`);
    expect((get.json as { name: string }).name).toBe('Renamed');

    const outsider = await signUpOrIn(
      `sr-rn-outsider-${ts}@example.test`,
      'outsider',
    );
    const denied = await outsider.patch(`/sheets/${sheet.id}`, {
      name: 'Hijacked',
    });
    expect(denied.status).toBe(403);

    const stillRenamed = await owner.get(`/sheets/${sheet.id}`);
    expect((stillRenamed.json as { name: string }).name).toBe('Renamed');
  });

  test('POST /boards/:id/sheets honours explicit positions as centres', async () => {
    const ts = Date.now();
    const owner = await signUpOrIn(`sr-pos-owner-${ts}@example.test`, 'owner');
    const group = withId(
      (await owner.post('/groups', { name: `SR-POS-${ts}` })).json,
    );
    const board = withId(
      (
        await owner.post(`/groups/${group.id}/boards`, {
          name: 'B',
          open: true,
        })
      ).json,
    );
    const img = await makeImage(board.id, 0, 'a'); // 200x100

    const created = withId(
      (
        await owner.post(`/boards/${board.id}/sheets`, {
          name: 'Positioned',
          imageIds: [img.id],
          positions: { [img.id]: { x: 1000, y: 2000 } },
        })
      ).json,
    );

    const elementsRes = await owner.get(`/sheets/${created.id}/elements`);
    const { elements } = elementsRes.json as {
      elements: { x: number; y: number; width: number; height: number }[];
    };
    expect(elements.length).toBe(1);
    const el = elements[0];
    if (!el) throw new Error('no element');
    // FIT=256 caps the fit-scale; the 200x100 image scales by 1 (already
    // under 256 on both axes), so width/height are its own pixel size.
    expect(el.width).toBe(200);
    expect(el.height).toBe(100);
    expect(el.x).toBe(1000 - 100); // centre.x - width/2
    expect(el.y).toBe(2000 - 50); // centre.y - height/2
  });
});
