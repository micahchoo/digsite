import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// docs/phases/6-product.md "Sheets are threads": sheet_reads/seen,
// archive/unarchive, GET /boards/:id/sheets excluding archived by default,
// GET /groups/:id/sheets's one-query cross-board shape.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createCanvas } from '@napi-rs/canvas';
import { createHttpServer } from '../app.ts';
import { pool } from '../db/pool.ts';
import { drain } from '../worker/index.ts';

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
      server.closeAllConnections();
      server.close(() => resolve());
    }),
);

class Session {
  cookie = '';

  private async raw(
    method: string,
    path: string,
    init: { json?: unknown; form?: FormData } = {},
  ): Promise<{ status: number; json: unknown }> {
    const headers: Record<string, string> = { Origin: base };
    if (this.cookie) headers.cookie = this.cookie;
    let body: string | FormData | undefined;
    if (init.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(init.json);
    } else if (init.form !== undefined) {
      body = init.form;
    }
    const res = await fetch(`${base}${path}`, { method, headers, body });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0] ?? '';
    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    return { status: res.status, json: parsed };
  }
  get(path: string) {
    return this.raw('GET', path);
  }
  post(path: string, json?: unknown) {
    return this.raw('POST', path, { json });
  }
  put(path: string, json?: unknown) {
    return this.raw('PUT', path, { json });
  }
  patch(path: string, json?: unknown) {
    return this.raw('PATCH', path, { json });
  }
  del(path: string) {
    return this.raw('DELETE', path);
  }
  postForm(path: string, form: FormData) {
    return this.raw('POST', path, { form });
  }
}

function withId(json: unknown): { id: string } {
  return json as { id: string };
}

async function signUp(email: string, name: string): Promise<Session> {
  const s = new Session();
  await s.post('/api/auth/sign-up/email', {
    email,
    password: 'password1234',
    name,
  });
  return s;
}

function onePixelPng(): Buffer {
  const canvas = createCanvas(4, 4);
  canvas.getContext('2d').fillRect(0, 0, 4, 4);
  return canvas.encodeSync('png');
}

describe('sheets are threads', () => {
  test('seen, archive/unarchive, and the group-wide sheet list', async () => {
    const ts = Date.now();
    const owner = await signUp(`thread-owner-${ts}@example.test`, 'owner');
    const group = await owner.post('/groups', { name: `Threads-${ts}` });
    const groupId = withId(group.json).id;
    const board = await owner.post(`/groups/${groupId}/boards`, {
      name: 'Field',
      open: true,
    });
    const boardId = withId(board.json).id;

    const form = new FormData();
    form.append(
      'files',
      new Blob([onePixelPng()], { type: 'image/png' }),
      'a.png',
    );
    const upload = await owner.postForm(
      `/boards/${boardId}/images?wait=0`,
      form,
    );
    const imageId = (upload.json as { id: string }[])[0]?.id;
    if (!imageId) throw new Error('fixture upload returned no image');
    await drain();

    const otherImage = await pool.query(
      `INSERT INTO images (board_id, slot, sha256, name, width, height, uploaded_by, properties)
       VALUES ($1, 1, $2, 'other.png', 4, 4, 'phase6-test', $3) RETURNING id`,
      [boardId, `thread-other-${ts}`, { mixed: 'text' }],
    );
    await pool.query('UPDATE boards SET image_count = 2 WHERE id = $1', [
      boardId,
    ]);
    const properties = await owner.patch(`/images/${imageId}`, {
      properties: {
        day: '1987-03-14',
        tags: ['archive', 'blue'],
        mixed: 1987,
      },
    });
    expect(properties.status).toBe(200);
    const boardResponse = await owner.get(`/boards/${boardId}`);
    expect(boardResponse.status).toBe(200);
    const sortableKeys = (
      boardResponse.json as {
        sortableKeys: { key: { property?: string; type?: string } | string }[];
      }
    ).sortableKeys;
    expect(
      sortableKeys.some(
        (key) =>
          typeof key.key === 'object' &&
          key.key.property === 'day' &&
          key.key.type === 'date',
      ),
    ).toBe(true);
    expect(
      sortableKeys.some(
        (key) =>
          typeof key.key === 'object' &&
          key.key.property === 'tags' &&
          key.key.type === 'list',
      ),
    ).toBe(true);
    expect(
      sortableKeys.some(
        (key) => typeof key.key === 'object' && key.key.property === 'mixed',
      ),
    ).toBe(false);
    expect(otherImage.rows[0]?.id).toBeTruthy();
    const badSelection = await owner.put(`/boards/${boardId}/selection`, {
      imageIds: ['not-a-uuid'],
    });
    expect(badSelection.status).toBe(400);

    const sheet = await owner.post(`/boards/${boardId}/sheets`, {
      name: 'First pass',
      imageIds: [imageId],
    });
    const sheetId = withId(sheet.json).id;
    const badAdd = await owner.post(
      `/boards/${boardId}/sheets/${sheetId}/images`,
      {
        imageIds: ['not-a-uuid'],
      },
    );
    expect(badAdd.status).toBe(400);

    // Unread until seen.
    let list = await owner.get(`/groups/${groupId}/sheets`);
    expect(list.status).toBe(200);
    let row = (list.json as { id: string; unread: boolean }[]).find(
      (r) => r.id === sheetId,
    );
    expect(row?.unread).toBe(true);

    const seen = await owner.post(`/sheets/${sheetId}/seen`);
    expect(seen.status).toBe(200);
    expect((seen.json as { seenAt: string }).seenAt).toBeTruthy();

    list = await owner.get(`/groups/${groupId}/sheets`);
    row = (list.json as { id: string; unread: boolean }[]).find(
      (r) => r.id === sheetId,
    );
    expect(row?.unread).toBe(false);
    expect(
      (list.json as { boardName: string; boardId: string }[])[0]?.boardId,
    ).toBe(boardId);

    // Archive: excluded from the default sheet list, present with ?archived=1.
    const archive = await owner.post(`/sheets/${sheetId}/archive`);
    expect(archive.status).toBe(200);
    expect((archive.json as { archived: boolean }).archived).toBe(true);

    const withoutArchived = await owner.get(`/boards/${boardId}/sheets`);
    expect(
      (withoutArchived.json as { id: string }[]).some((s) => s.id === sheetId),
    ).toBe(false);

    const withArchived = await owner.get(
      `/boards/${boardId}/sheets?archived=1`,
    );
    const archivedRow = (
      withArchived.json as { id: string; archived: boolean }[]
    ).find((s) => s.id === sheetId);
    expect(archivedRow?.archived).toBe(true);

    const unarchive = await owner.post(`/sheets/${sheetId}/unarchive`);
    expect(unarchive.status).toBe(200);
    expect((unarchive.json as { archived: boolean }).archived).toBe(false);
    const backInList = await owner.get(`/boards/${boardId}/sheets`);
    expect(
      (backInList.json as { id: string }[]).some((s) => s.id === sheetId),
    ).toBe(true);

    // Deleting a sheet after marking it seen removes the dependent read row.
    const deleted = await owner.del(`/sheets/${sheetId}`);
    expect(deleted.status).toBe(200);
  });
});
