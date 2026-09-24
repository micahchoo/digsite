// Kept and published reports over HTTP (CONTEXT.md "Kept report",
// "Published report"): keep one, see what changed since, publish a link a
// stranger reads with no session, revoke it, let it expire, remove it.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ReportChanges, ReportData } from '@digsite/shared';
import { createCanvas } from '@napi-rs/canvas';
import { createHttpServer } from '../app.ts';
import { pool } from '../db/pool.ts';
import { saveSnapshotAndProject } from '../sheets/snapshot.ts';
import { drain } from '../worker/index.ts';

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
  ): Promise<{ status: number; json: T; type: string | null }> {
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
    const type = res.headers.get('content-type');
    const text = type?.includes('json') ? await res.text() : '';
    return {
      status: res.status,
      json: (text ? JSON.parse(text) : null) as T,
      type,
    };
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
    [boardId, slot, `sha-rr-${Date.now()}-${Math.random()}`, `img-${slot}`],
  );
  return rows[0].id;
}

let v = 0;
const el = (id: string, custom: Record<string, unknown>, extra = {}) => ({
  id,
  version: ++v,
  versionNonce: v,
  type: 'rectangle',
  isDeleted: false,
  x: 0,
  y: 0,
  width: 200,
  height: 200,
  updated: Date.now(),
  customData: custom,
  ...extra,
});
const pic = (id: string, imageId: string, x: number) =>
  el(id, { kind: 'image', imageId }, { type: 'image', x });
const line = (id: string, from: string, to: string, confidence: string) =>
  el(
    id,
    {
      kind: 'edge',
      relation: 'same place',
      direction: 'forward',
      properties: {},
      confidence,
      note: '',
    },
    {
      type: 'arrow',
      startBinding: { elementId: from },
      endBinding: { elementId: to },
    },
  );

describe('kept and published reports', () => {
  test('keep, change, compare, publish, read as a stranger, revoke, expire, remove', async () => {
    const ts = Date.now();
    const owner = await signUp(`rr-owner-${ts}@example.test`);
    const stranger = new Session();
    const group = (
      await owner.req<{ id: string }>('POST', '/groups', { name: `RR-${ts}` })
    ).json;
    const board = (
      await owner.req<{ id: string }>('POST', `/groups/${group.id}/boards`, {
        name: 'Chimneys',
        open: true,
      })
    ).json;
    const other = (
      await owner.req<{ id: string }>('POST', `/groups/${group.id}/boards`, {
        name: 'Elsewhere',
        open: true,
      })
    ).json;
    const [a, b, c] = [
      await makeImage(board.id, 0),
      await makeImage(board.id, 1),
      await makeImage(board.id, 2),
    ];
    const sheet = (
      await owner.req<{ id: string }>('POST', `/boards/${board.id}/sheets`, {
        name: 'First pass',
        imageIds: [a, b, c],
      })
    ).json;
    await saveSnapshotAndProject(sheet.id, [
      pic('pa', a, 0),
      pic('pb', b, 300),
      pic('pc', c, 600),
      line('e1', 'pa', 'pb', 'likely'),
    ]);

    // Keep it.
    const kept = await owner.req<ReportData>(
      'POST',
      `/boards/${board.id}/reports`,
      { scope: { kind: 'sheet', sheetId: sheet.id }, title: 'For the museum' },
    );
    expect(kept.status).toBe(201);
    expect(kept.json.id).toBeString();
    expect(kept.json.title).toBe('For the museum');
    const id = kept.json.id as string;
    expect(
      (await owner.req<ReportData>('GET', `/reports/${id}`)).json.claims.map(
        (x) => x.elementId,
      ),
    ).toEqual(['e1']);
    const listed = await owner.req<{
      reports: { id: string; claims: number }[];
    }>('GET', `/boards/${board.id}/reports`);
    expect(listed.json.reports).toMatchObject([{ id, claims: 1, link: null }]);

    // A sheet of another board cannot be kept here.
    const wrong = await owner.req('POST', `/boards/${other.id}/reports`, {
      scope: { kind: 'sheet', sheetId: sheet.id },
    });
    expect(wrong.status).toBe(400);

    // The sheet moves on: the kept report does not, and says what changed.
    await saveSnapshotAndProject(sheet.id, [
      pic('pa', a, 0),
      pic('pb', b, 300),
      pic('pc', c, 600),
      line('e1', 'pa', 'pb', 'confirmed'),
      line('e2', 'pb', 'pc', 'likely'),
    ]);
    const changes = await owner.req<ReportChanges>(
      'GET',
      `/reports/${id}/changes`,
    );
    expect(changes.json.added.map((x) => x.elementId)).toEqual(['e2']);
    expect(changes.json.changed.map((x) => x.fields)).toEqual([['confidence']]);
    expect(
      (await owner.req<ReportData>('GET', `/reports/${id}`)).json.claims[0]
        ?.confidence,
    ).toBe('likely');

    // Publish: a stranger with no session reads it and its pictures only.
    const link = await owner.req<{ token: string; expiresAt: string }>(
      'POST',
      `/reports/${id}/link`,
      { days: 7 },
    );
    expect(link.status).toBe(200);
    expect(link.json.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Date.parse(link.json.expiresAt)).toBeGreaterThan(Date.now());
    const token = link.json.token;
    const read = await stranger.req<ReportData>('GET', `/published/${token}`);
    expect(read.status).toBe(200);
    expect(read.json.id).toBe(id);
    const picture = await stranger.req(
      'GET',
      `/published/${token}/images/${a}`,
    );
    expect(picture.status).toBe(200);
    expect(picture.type).toBe('image/png');
    const notShown = await makeImage(board.id, 3);
    expect(
      (await stranger.req('GET', `/published/${token}/images/${notShown}`))
        .status,
    ).toBe(404);
    expect((await stranger.req('GET', `/reports/${id}`)).status).toBe(401);

    // A bad number of days is refused; a new link replaces the old one.
    expect(
      (await owner.req('POST', `/reports/${id}/link`, { days: 0 })).status,
    ).toBe(400);
    const again = await owner.req<{ token: string }>(
      'POST',
      `/reports/${id}/link`,
      {},
    );
    expect((await stranger.req('GET', `/published/${token}`)).status).toBe(404);
    const second = again.json.token;
    expect((await stranger.req('GET', `/published/${second}`)).status).toBe(
      200,
    );

    // Expired reads as unknown; so does revoked.
    await pool.query(
      `UPDATE reports SET expires_at = now() - interval '1 minute' WHERE id = $1`,
      [id],
    );
    expect((await stranger.req('GET', `/published/${second}`)).status).toBe(
      404,
    );
    const third = (
      await owner.req<{ token: string }>('POST', `/reports/${id}/link`, {
        days: null,
      })
    ).json.token;
    expect((await stranger.req('GET', `/published/${third}`)).status).toBe(200);
    expect((await owner.req('DELETE', `/reports/${id}/link`)).status).toBe(200);
    expect((await stranger.req('GET', `/published/${third}`)).status).toBe(404);

    // Removed with the board.
    expect((await owner.req('DELETE', `/boards/${board.id}`)).status).toBe(200);
    const { rows } = await pool.query('SELECT 1 FROM reports WHERE id = $1', [
      id,
    ]);
    expect(rows.length).toBe(0);
  });
});

/** The entries of a zip whose entries are stored whole (boards/zip.ts). */
function unzip(buf: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out = new Map<string, Uint8Array>();
  let at = 0;
  while (at + 30 <= buf.length && view.getUint32(at, true) === 0x04034b50) {
    const size = view.getUint32(at + 18, true);
    const nameLength = view.getUint16(at + 26, true);
    const name = new TextDecoder().decode(
      buf.subarray(at + 30, at + 30 + nameLength),
    );
    const start = at + 30 + nameLength;
    out.set(name, buf.subarray(start, start + size));
    at = start + size;
  }
  return out;
}

describe('a kept report’s evidence', () => {
  test('holds its data in every format and every original, each checkable by SHA256SUMS', async () => {
    const ts = Date.now();
    const owner = await signUp(`rb-owner-${ts}@example.test`);
    const group = (
      await owner.req<{ id: string }>('POST', '/groups', { name: `RB-${ts}` })
    ).json;
    const board = (
      await owner.req<{ id: string }>('POST', `/groups/${group.id}/boards`, {
        name: 'Evidence',
        open: true,
      })
    ).json;
    const form = new FormData();
    for (const [name, colour] of [
      ['north.png', '#a33'],
      ['south.png', '#3a3'],
    ] as const) {
      const canvas = createCanvas(8, 6);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = colour;
      ctx.fillRect(0, 0, 8, 6);
      form.append('files', new Blob([canvas.encodeSync('png')]), name);
    }
    const upload = await fetch(`${base}/boards/${board.id}/images?wait=0`, {
      method: 'POST',
      headers: { Origin: base, cookie: owner.cookie },
      body: form,
    });
    expect(upload.status).toBe(202);
    const [north, south] = ((await upload.json()) as { id: string }[]).map(
      (i) => i.id,
    );
    await drain();
    const sheet = (
      await owner.req<{ id: string }>('POST', `/boards/${board.id}/sheets`, {
        name: 'Both',
        imageIds: [north, south],
      })
    ).json;
    await saveSnapshotAndProject(sheet.id, [
      pic('pn', north as string, 0),
      pic('ps', south as string, 300),
      line('e', 'pn', 'ps', 'confirmed'),
    ]);
    const kept = await owner.req<ReportData>(
      'POST',
      `/boards/${board.id}/reports`,
      { scope: { kind: 'sheet', sheetId: sheet.id } },
    );
    const res = await fetch(`${base}/reports/${kept.json.id}/bundle`, {
      headers: { Origin: base, cookie: owner.cookie },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    const files = unzip(new Uint8Array(await res.arrayBuffer()));
    expect([...files.keys()].sort()).toEqual([
      'README.txt',
      'SHA256SUMS',
      'annotations.jsonld',
      'claims.csv',
      'graph.graphml',
      'pictures/north.png',
      'pictures/south.png',
      'report.json',
    ]);
    // Every line of SHA256SUMS holds for the bytes beside it.
    const sums = new TextDecoder()
      .decode(files.get('SHA256SUMS'))
      .trim()
      .split('\n');
    expect(sums).toHaveLength(7);
    for (const line of sums) {
      const [hash, name] = line.split('  ');
      const bytes = files.get(name ?? '') as Uint8Array;
      expect(new Bun.CryptoHasher('sha256').update(bytes).digest('hex')).toBe(
        hash as string,
      );
    }
    // And a picture's file is the one the report cites.
    const cited = kept.json.images.find((i) => i.name === 'north.png');
    expect(sums).toContain(`${cited?.sha256}  pictures/north.png`);
    const readme = new TextDecoder().decode(files.get('README.txt'));
    expect(readme).toContain('sha256sum -c SHA256SUMS');
    expect(readme).not.toContain('differ');

    // Importing it: the board says which cited pictures it holds.
    const found = await owner.req<{
      images: { id: string; sha256: string; name: string }[];
    }>('POST', `/boards/${board.id}/images/by-sha256`, {
      hashes: [cited?.sha256, 'f'.repeat(64), 'not a hash'],
    });
    expect(found.json.images).toEqual([
      {
        id: north as string,
        sha256: cited?.sha256 as string,
        name: 'north.png',
      },
    ]);
  });
});
