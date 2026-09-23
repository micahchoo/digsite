// CONTEXT.md "Making sense" over HTTP: every route the web calls for it,
// through a real session, the way lib/api.ts calls them. making-sense.test.ts
// tests the functions underneath; this tests the routes that parse the
// request, check access and shape the response.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type {
  AliasesResponse,
  FindBoardResponse,
  GetBoardVocabularyResponse,
  GetSheetReachResponse,
  GetSheetRowsResponse,
} from '@digsite/shared/api';
import { createHttpServer } from '../app.ts';
import { pool } from '../db/pool.ts';
import { saveSnapshotAndProject } from '../sheets/snapshot.ts';

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

const el = (partial: Record<string, unknown>) => ({
  version: 1,
  versionNonce: 1,
  isDeleted: false,
  x: 0,
  y: 0,
  width: 200,
  height: 200,
  ...partial,
});

describe('making sense, over HTTP', () => {
  test('vocabulary, aliases, find by term, reach and edge rows', async () => {
    const ts = Date.now();
    const owner = await signUp(`msr-owner-${ts}@example.test`);
    const outsider = await signUp(`msr-outsider-${ts}@example.test`);
    const group = (
      await owner.req<{ id: string }>('POST', '/groups', {
        name: `MSR-${ts}`,
      })
    ).json;
    const board = (
      await owner.req<{ id: string }>('POST', `/groups/${group.id}/boards`, {
        name: 'B',
        open: true,
      })
    ).json;
    const [a, b, c] = [
      await makeImage(board.id, 0),
      await makeImage(board.id, 1),
      await makeImage(board.id, 2),
    ];
    if (!a || !b || !c) throw new Error('fixture: images');

    const s1 = (
      await owner.req<{ id: string }>('POST', `/boards/${board.id}/sheets`, {
        name: 'One',
        imageIds: [a, b],
      })
    ).json;
    const s2 = (
      await owner.req<{ id: string }>('POST', `/boards/${board.id}/sheets`, {
        name: 'Two',
        imageIds: [b, c],
      })
    ).json;
    await saveSnapshotAndProject(s1.id, [
      el({
        id: 'ia',
        type: 'image',
        customData: { kind: 'image', imageId: a },
      }),
      el({
        id: 'ib',
        type: 'image',
        x: 300,
        customData: { kind: 'image', imageId: b },
      }),
      el({
        id: 'ra',
        type: 'rectangle',
        x: 20,
        y: 20,
        width: 40,
        height: 40,
        customData: {
          kind: 'region',
          imageId: a,
          label: 'roofline',
          properties: {},
        },
      }),
      el({
        id: 'e1',
        type: 'arrow',
        startBinding: { elementId: 'ra' },
        endBinding: { elementId: 'ib' },
        customData: {
          kind: 'edge',
          relation: 'same place',
          direction: 'forward',
          properties: {},
          confidence: 'likely',
          note: 'same chimney',
        },
      }),
    ]);
    await saveSnapshotAndProject(s2.id, [
      el({
        id: 'jb',
        type: 'image',
        customData: { kind: 'image', imageId: b },
      }),
      el({
        id: 'jc',
        type: 'image',
        x: 300,
        customData: { kind: 'image', imageId: c },
      }),
      el({
        id: 'e2',
        type: 'arrow',
        startBinding: { elementId: 'jb' },
        endBinding: { elementId: 'jc' },
        customData: {
          kind: 'edge',
          relation: 'same location',
          direction: 'forward',
          properties: {},
        },
      }),
    ]);

    // -- rows carry confidence and note --------------------------------------
    const rows = await owner.req<GetSheetRowsResponse>(
      'GET',
      `/sheets/${s1.id}/rows`,
    );
    expect(rows.status).toBe(200);
    expect(rows.json.edges[0]).toMatchObject({
      relation: 'same place',
      confidence: 'likely',
      note: 'same chimney',
    });

    // -- vocabulary -----------------------------------------------------------
    const vocab = await owner.req<GetBoardVocabularyResponse>(
      'GET',
      `/boards/${board.id}/vocabulary`,
    );
    expect(vocab.status).toBe(200);
    expect(vocab.json.labels).toEqual([
      { term: 'roofline', count: 1, aliases: [] },
    ]);
    expect(vocab.json.relations.map((t) => t.term).sort()).toEqual([
      'same location',
      'same place',
    ]);
    expect(
      (await outsider.req('GET', `/boards/${board.id}/vocabulary`)).status,
    ).toBe(403);

    // -- aliases: bad input refused, a merge folds counts ----------------------
    expect(
      (
        await owner.req('PUT', `/boards/${board.id}/aliases`, {
          kind: 'colour',
          term: 'x',
          canonical: 'y',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await owner.req('PUT', `/boards/${board.id}/aliases`, {
          kind: 'relation',
          term: 'same place',
          canonical: 'same place',
        })
      ).status,
    ).toBe(400);
    const merged = await owner.req<AliasesResponse>(
      'PUT',
      `/boards/${board.id}/aliases`,
      { kind: 'relation', term: 'same location', canonical: 'same place' },
    );
    expect(merged.status).toBe(200);
    expect(merged.json.relation).toEqual({ 'same location': 'same place' });
    expect(
      (
        await outsider.req('PUT', `/boards/${board.id}/aliases`, {
          kind: 'relation',
          term: 'a',
          canonical: 'b',
        })
      ).status,
    ).toBe(403);
    const folded = await owner.req<GetBoardVocabularyResponse>(
      'GET',
      `/boards/${board.id}/vocabulary`,
    );
    expect(folded.json.relations).toEqual([
      { term: 'same place', count: 2, aliases: ['same location'] },
    ]);

    // -- find by term, through the alias --------------------------------------
    const byLabel = await owner.req<FindBoardResponse>(
      'GET',
      `/boards/${board.id}/find?q=&label=roofline`,
    );
    expect(byLabel.status).toBe(200);
    expect(byLabel.json.imageIds).toEqual([a]);
    const byRelation = await owner.req<FindBoardResponse>(
      'GET',
      `/boards/${board.id}/find?q=&relation=${encodeURIComponent('same place')}`,
    );
    expect(byRelation.json.imageIds.sort()).toEqual([a, b, c].sort());
    expect(byRelation.json.ranks).toHaveLength(3);
    const annotated = await owner.req<FindBoardResponse>(
      'GET',
      `/boards/${board.id}/find?q=&annotated=1`,
    );
    expect(annotated.json.count).toBe(3);

    // -- separating the alias restores the term --------------------------------
    const separated = await owner.req<AliasesResponse>(
      'DELETE',
      `/boards/${board.id}/aliases/relation/${encodeURIComponent('same location')}`,
    );
    expect(separated.status).toBe(200);
    expect(separated.json.relation).toEqual({});
    const unmerged = await owner.req<FindBoardResponse>(
      'GET',
      `/boards/${board.id}/find?q=&relation=${encodeURIComponent('same place')}`,
    );
    expect(unmerged.json.imageIds.sort()).toEqual([a, b].sort());

    // -- reach: S2's b -> c leaves S1 at b --------------------------------------
    const reach = await owner.req<GetSheetReachResponse>(
      'GET',
      `/sheets/${s1.id}/reach`,
    );
    expect(reach.status).toBe(200);
    expect(
      reach.json.edges.map((e) => [e.sheetName, e.relation, e.near]),
    ).toEqual([['Two', 'same location', 'source']]);
    expect(reach.json.images.map((i) => i.id)).toEqual([c]);
    expect((await outsider.req('GET', `/sheets/${s1.id}/reach`)).status).toBe(
      403,
    );
  });
});
