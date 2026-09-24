import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// boards/intake.ts: one admission for every way a picture enters. The
// content type comes from the bytes; a camera file becomes a JPEG on any
// path, the browser's included; a duplicate is refused only when asked.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import sharp from 'sharp';
import { createHttpServer } from '../app.ts';
import { extractRegion } from '../boards/extract.ts';
import { examine, store, storeAll } from '../boards/intake.ts';
import { pool } from '../db/pool.ts';
import { storageOf } from '../storage/quota.ts';

const HEIC = join(import.meta.dir, 'fixtures', 'split-64x48.heic');
const png = () =>
  sharp({ create: { width: 8, height: 8, channels: 3, background: '#39c' } })
    .png()
    .toBuffer();

async function board(): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO boards (org_id, name, open, created_by)
     VALUES ('org-intake', $1, true, 'tester') RETURNING id`,
    [`intake-${Date.now()}-${Math.random()}`],
  );
  return rows[0].id;
}

describe('examine', () => {
  test('the type comes from the bytes, whatever the name says', async () => {
    const got = await examine(await board(), {
      name: 'photo.jpg',
      bytes: new Uint8Array(await png()),
    });
    expect(got.ok && got.contentType).toBe('image/png');
  });

  test('a camera file becomes a JPEG and keeps what it was', async () => {
    const got = await examine(await board(), {
      name: 'IMG_0001.HEIC',
      bytes: new Uint8Array(await Bun.file(HEIC).arrayBuffer()),
      properties: { site: 'A' },
    });
    expect(got.ok && [got.contentType, got.properties]).toEqual([
      'image/jpeg',
      { site: 'A', format: 'HEIC' },
    ]);
  });

  test('a file that is not an image is refused with a reason; a duplicate only when asked', async () => {
    const boardId = await board();
    const bad = await examine(boardId, {
      name: 'x.png',
      bytes: new TextEncoder().encode('no'),
    });
    expect(bad).toMatchObject({ ok: false, status: 415 });
    const bytes = new Uint8Array(await png());
    const first = await examine(boardId, { name: 'a.png', bytes });
    if (!first.ok) throw new Error(first.reason);
    await store(boardId, 'tester', first);
    expect((await examine(boardId, { name: 'b.png', bytes })).ok).toBe(true);
    expect(
      await examine(
        boardId,
        { name: 'b.png', bytes },
        { skipDuplicates: true },
      ),
    ).toEqual({
      ok: false,
      status: 409,
      reason: 'already on this board as a.png',
    });
  });
});

describe('properties', () => {
  test('a value that is not a property map is refused, on every path', async () => {
    const bytes = new Uint8Array(await png());
    for (const properties of ['{"year":', [1, 2], { nested: { a: 1 } }]) {
      const got = await examine(await board(), {
        name: 'p.png',
        bytes,
        properties,
      });
      expect(got.ok ? 'taken' : got.status).toBe(400);
    }
  });
});

describe('storeAll', () => {
  const coloured = (r: number) =>
    sharp({
      create: {
        width: 8,
        height: 8,
        channels: 3,
        background: { r, g: 1, b: 2 },
      },
    })
      .png({ compressionLevel: 0 })
      .toBuffer();

  test('stops at the quota and names, in order, the files that landed', async () => {
    const orgId = `org-storeall-${Date.now()}-${Math.random()}`;
    const { rows } = await pool.query(
      `INSERT INTO boards (org_id, name, open, created_by)
       VALUES ($1, 'q', true, 'tester') RETURNING id`,
      [orgId],
    );
    const boardId = rows[0].id as string;
    const files = [];
    for (const r of [10, 20, 30, 40, 50]) {
      const got = await examine(boardId, {
        name: `f${r}.png`,
        bytes: new Uint8Array(await coloured(r)),
      });
      if (got.ok) files.push(got);
    }
    const size = files[0]?.bytes.length ?? 0;
    await pool.query(
      'INSERT INTO group_storage (org_id, quota_bytes) VALUES ($1, $2)',
      [orgId, size * 2 + Math.floor(size / 2)],
    );

    const { images, full } = await storeAll(boardId, 'tester', files);

    expect(images).toHaveLength(2);
    expect(full?.accepted).toEqual([
      { name: 'f10.png', id: images[0]?.id as string },
      { name: 'f20.png', id: images[1]?.id as string },
    ]);
    expect(full?.reason).toBe('quota');
    expect((await storageOf(orgId)).usedBytes).toBe(size * 2);
  });

  test('a batch that fits is stored whole', async () => {
    const boardId = await board();
    const got = await examine(boardId, {
      name: 'one.png',
      bytes: new Uint8Array(await coloured(77)),
    });
    const { images, full } = await storeAll(
      boardId,
      'tester',
      got.ok ? [got] : [],
    );
    expect(images).toHaveLength(1);
    expect(full).toBeNull();
  });
});

describe('an extracted region goes through intake', () => {
  test('a crop of a picture named like a camera file is taken as the PNG it is', async () => {
    const boardId = await board();
    const got = await examine(boardId, {
      name: 'IMG_0002.HEIC',
      bytes: new Uint8Array(await Bun.file(HEIC).arrayBuffer()),
    });
    if (!got.ok) throw new Error(got.reason);
    const parent = await store(boardId, 'tester', got);
    const { rows } = await pool.query(
      'SELECT id, board_id, sha256, name FROM images WHERE id = $1',
      [parent.id],
    );
    const extracted = await extractRegion(
      rows[0],
      { fx: 0, fy: 0, fw: 0.5, fh: 0.5 },
      'corner',
      'tester',
    );
    expect(
      extracted && 'reason' in extracted ? extracted.reason : 'taken',
    ).toBe('taken');
  });
});

describe('the browser upload goes through intake', () => {
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

  async function request(method: string, path: string, body?: unknown) {
    const headers: Record<string, string> = { Origin: base };
    if (cookie) headers.cookie = cookie;
    let payload: FormData | string | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: payload,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0] ?? '';
    return res;
  }

  test('a phone photo uploaded from a browser becomes an image', async () => {
    const ts = Date.now();
    await request('POST', '/api/auth/sign-up/email', {
      email: `intake-${ts}@example.test`,
      password: 'password1234',
      name: 'owner',
    });
    const group = (await (
      await request('POST', '/groups', { name: `Intake-${ts}` })
    ).json()) as { id: string };
    const created = (await (
      await request('POST', `/groups/${group.id}/boards`, {
        name: 'B',
        open: true,
      })
    ).json()) as { id: string };
    const form = new FormData();
    form.append(
      'files',
      new File([await Bun.file(HEIC).arrayBuffer()], 'IMG_0002.HEIC', {
        type: 'text/plain',
      }),
    );
    const res = await request(
      'POST',
      `/boards/${created.id}/images?wait=0`,
      form,
    );
    expect(res.status).toBe(202); // ?wait=0: accepted, not yet painted
    const { rows } = await pool.query(
      'SELECT name, properties FROM images WHERE board_id = $1',
      [created.id],
    );
    expect(rows.map((r) => [r.name, r.properties.format])).toEqual([
      ['IMG_0002.HEIC', 'HEIC'],
    ]);

    // The phone's file is kept, and comes back byte for byte.
    const { rows: ids } = await pool.query(
      'SELECT id FROM images WHERE board_id = $1',
      [created.id],
    );
    const imageId = ids[0].id as string;
    const source = await request('GET', `/images/${imageId}/source`);
    expect(source.status).toBe(200);
    expect(source.headers.get('content-disposition')).toContain(
      'IMG_0002.heic',
    );
    const heic = Buffer.from(await Bun.file(HEIC).arrayBuffer());
    expect(Buffer.from(await source.arrayBuffer()).equals(heic)).toBe(true);
    const listed = (await (
      await request(
        'GET',
        `/boards/${created.id}/images?sort=name.asc&ids=${imageId}`,
      )
    ).json()) as { images: { source?: unknown }[] };
    expect(listed.images[0]?.source).toEqual({
      format: 'HEIC',
      bytes: heic.length,
    });

    // Deleting the image removes the kept file with the original.
    expect((await request('DELETE', `/images/${imageId}`)).status).toBe(200);
    expect((await request('GET', `/images/${imageId}/source`)).status).toBe(
      404,
    );
  });
});
