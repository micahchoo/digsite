// CONTEXT.md "Extract": a region made into a picture of its own, through
// the real route, from a real original, in the displayed frame.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';
import { createHttpServer } from '../app.ts';
import { cropBox, parseFraction } from '../boards/extract.ts';
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
  async postForm<T>(path: string, form: FormData) {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { Origin: base, cookie: this.cookie },
      body: form,
    });
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

describe('cropBox and parseFraction', () => {
  test('a fraction becomes whole pixels, inside the picture, at least one', () => {
    expect(cropBox({ fx: 0.25, fy: 0.5, fw: 0.5, fh: 0.25 }, 400, 200)).toEqual(
      {
        left: 100,
        top: 100,
        width: 200,
        height: 50,
      },
    );
    expect(
      cropBox({ fx: 0.9, fy: 0.9, fw: 0.5, fh: 0.0001 }, 100, 100),
    ).toEqual({
      left: 90,
      top: 90,
      width: 10,
      height: 1,
    });
  });
  test('refuses a region with no size or outside the picture', () => {
    expect(parseFraction({ fx: 0, fy: 0, fw: 0, fh: 0.5 })).toBeNull();
    expect(parseFraction({ fx: 1, fy: 0, fw: 0.1, fh: 0.5 })).toBeNull();
    expect(parseFraction({ fx: 0, fy: 0, fw: 0.5 })).toBeNull();
    expect(parseFraction({ fx: 0.1, fy: 0.2, fw: 0.3, fh: 0.4 })).toEqual({
      fx: 0.1,
      fy: 0.2,
      fw: 0.3,
      fh: 0.4,
    });
  });
});

describe('POST /images/:id/extract', () => {
  test('crops in the displayed frame and adds the crop to the board', async () => {
    const ts = Date.now();
    const owner = await signUp(`ext-owner-${ts}@example.test`);
    const outsider = await signUp(`ext-outsider-${ts}@example.test`);
    const group = (
      await owner.req<{ id: string }>('POST', '/groups', { name: `EXT-${ts}` })
    ).json;
    const board = (
      await owner.req<{ id: string }>('POST', `/groups/${group.id}/boards`, {
        name: 'B',
        open: true,
      })
    ).json;
    // Stored 200 wide and 100 tall, EXIF orientation 6: DISPLAYED 100 x 200.
    // Left half red, right half blue as stored, so after the turn the top
    // half is red and the bottom half blue.
    const stored = await sharp({
      create: { width: 200, height: 100, channels: 3, background: '#0000ff' },
    })
      .composite([
        {
          input: await sharp({
            create: {
              width: 100,
              height: 100,
              channels: 3,
              background: '#ff0000',
            },
          })
            .png()
            .toBuffer(),
          left: 0,
          top: 0,
        },
      ])
      .withMetadata({ orientation: 6 })
      .jpeg({ quality: 100 })
      .toBuffer();
    const form = new FormData();
    form.append(
      'files',
      new Blob([stored], { type: 'image/jpeg' }),
      'turned.jpg',
    );
    const up = await owner.postForm<{ id: string }[]>(
      `/boards/${board.id}/images?wait=0`,
      form,
    );
    expect(up.status).toBe(202);
    const imageId = up.json[0]?.id ?? '';

    const path = `/images/${imageId}/extract`;
    expect(
      (await outsider.req('POST', path, { fx: 0, fy: 0, fw: 1, fh: 0.5 }))
        .status,
    ).toBe(403);
    expect(
      (await owner.req('POST', path, { fx: 0, fy: 0, fw: 0, fh: 0.5 })).status,
    ).toBe(400);

    const cut = await owner.req<{
      id: string;
      name: string;
      width: number;
      height: number;
    }>('POST', path, { fx: 0, fy: 0.5, fw: 1, fh: 0.5, label: 'lower half' });
    expect(cut.status).toBe(202);
    // The displayed picture is 100 x 200; its lower half is 100 x 100.
    expect(cut.json).toMatchObject({
      name: 'lower half · turned.jpg',
      width: 100,
      height: 100,
    });
    const { rows } = await pool.query(
      'SELECT board_id, properties FROM images WHERE id = $1',
      [cut.json.id],
    );
    expect(rows[0]?.board_id).toBe(board.id);
    expect(rows[0]?.properties).toMatchObject({
      derived_from: 'turned.jpg',
      derived_region: '0.0000,0.5000,1.0000,0.5000',
    });
    // And the crop is what was shown there: blue, not red.
    const { rows: shaRows } = await pool.query(
      'SELECT sha256 FROM images WHERE id = $1',
      [cut.json.id],
    );
    const { storageFromEnv } = await import('../storage/index.ts');
    const { originalKey } = await import('../boards/paths.ts');
    const bytes = await storageFromEnv().get(
      originalKey(board.id, shaRows[0]?.sha256),
    );
    if (!bytes) throw new Error('no crop stored');
    // Sampled in the middle: at the seam, JPEG blends red into blue.
    const { data, info } = await sharp(bytes)
      .raw()
      .toBuffer({ resolveWithObject: true });
    const at =
      (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) *
      info.channels;
    const [r, b] = [data[at] ?? 0, data[at + 2] ?? 0];
    expect(b).toBeGreaterThan(200);
    expect(r).toBeLessThan(60);
  });
});
