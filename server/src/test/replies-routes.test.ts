// CONTEXT.md "Reply" over HTTP: what people say about a claim, through real
// sessions, the way lib/api.ts calls the routes.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ClaimReply, GetRepliesResponse } from '@digsite/shared/api';
import { createHttpServer } from '../app.ts';
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

class Session {
  cookie = '';
  async req<T>(
    method: string,
    path: string,
    json?: unknown,
  ): Promise<{ status: number; json: T }> {
    const headers: Record<string, string> = { Origin: base };
    if (this.cookie) headers.cookie = this.cookie;
    if (json !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0] ?? '';
    const text = await res.text();
    return { status: res.status, json: (text ? JSON.parse(text) : null) as T };
  }
}

async function signUp(email: string): Promise<Session> {
  const s = new Session();
  const up = await s.req('POST', '/api/auth/sign-up/email', {
    email,
    password: 'password1234',
    name: email.split('@')[0],
  });
  if (up.status !== 200) throw new Error(`sign-up failed: ${up.status}`);
  return s;
}

async function makeImage(boardId: string, slot: number): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO images (board_id, slot, sha256, name, width, height, uploaded_by)
     VALUES ($1,$2,$3,$4,200,200,'tester') RETURNING id`,
    [boardId, slot, `sha-msr-${Date.now()}-${Math.random()}`, `img-${slot}`],
  );
  return rows[0].id;
}

describe('replies on a claim, over HTTP', () => {
  test('anyone who sees the board replies; only the writer removes', async () => {
    const ts = Date.now();
    const owner = await signUp(`rep-owner-${ts}@example.test`);
    const outsider = await signUp(`rep-outsider-${ts}@example.test`);
    const group = (
      await owner.req<{ id: string }>('POST', '/groups', { name: `REP-${ts}` })
    ).json;
    const board = (
      await owner.req<{ id: string }>('POST', `/groups/${group.id}/boards`, {
        name: 'B',
        open: true,
      })
    ).json;
    const a = await makeImage(board.id, 0);
    const sheet = (
      await owner.req<{ id: string }>('POST', `/boards/${board.id}/sheets`, {
        name: 'One',
        imageIds: [a],
      })
    ).json;
    const base = `/sheets/${sheet.id}/replies`;

    const added = await owner.req<ClaimReply>('POST', base, {
      elementId: 'edge-1',
      text: '  The chimney lines up.  ',
    });
    expect(added.status).toBe(201);
    expect(added.json).toMatchObject({
      elementId: 'edge-1',
      text: 'The chimney lines up.',
    });
    expect(added.json.by.name).toBe(`rep-owner-${ts}`);

    // Refused: empty, too long, no claim named, and anyone off the board.
    expect(
      (await owner.req('POST', base, { elementId: 'edge-1', text: ' ' }))
        .status,
    ).toBe(400);
    expect(
      (
        await owner.req('POST', base, {
          elementId: 'edge-1',
          text: 'x'.repeat(2001),
        })
      ).status,
    ).toBe(400);
    expect((await owner.req('POST', base, { text: 'hi' })).status).toBe(400);
    expect(
      (await outsider.req('POST', base, { elementId: 'edge-1', text: 'hi' }))
        .status,
    ).toBe(403);
    expect((await outsider.req('GET', base)).status).toBe(403);

    await owner.req('POST', base, { elementId: 'edge-1', text: 'Second.' });
    const listed = await owner.req<GetRepliesResponse>('GET', base);
    expect(listed.json.replies.map((r) => r.text)).toEqual([
      'The chimney lines up.',
      'Second.',
    ]);

    // Only its writer removes a reply; a removed reply is gone from the list.
    expect(
      (await outsider.req('DELETE', `${base}/${added.json.id}`)).status,
    ).toBe(403);
    expect((await owner.req('DELETE', `${base}/${added.json.id}`)).status).toBe(
      200,
    );
    expect((await owner.req('DELETE', `${base}/${added.json.id}`)).status).toBe(
      403,
    );
    const after = await owner.req<GetRepliesResponse>('GET', base);
    expect(after.json.replies.map((r) => r.text)).toEqual(['Second.']);
  });
});
