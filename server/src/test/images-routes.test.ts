import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// GET /images/:id/preview: added for the synthetic million-image board,
// whose images have ladder pages but no original (this task's own
// coordinator note, not docs/phases/3-groups.md). Under `imageForViewing`,
// same as `GET /images/:id/original` and `/images/:id`.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { createHttpServer } from '../app.ts';
import { paintLadder } from '../boards/ladder.ts';
import { originalPath, previewPath } from '../boards/paths.ts';
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
  ): Promise<{ status: number; headers: Headers; buf: Buffer }> {
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
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, headers: res.headers, buf };
  }

  get(path: string) {
    return this.raw('GET', path);
  }
  post(path: string, json?: unknown) {
    return this.raw('POST', path, { json });
  }
}

function withId(buf: Buffer): { id: string } {
  return JSON.parse(buf.toString('utf8')) as { id: string };
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
  if (inn.status !== 200) throw new Error(`sign-in failed ${email}`);
  return s;
}

async function makeImage(
  boardId: string,
  slot: number,
  sha256: string,
  opts: { missing?: boolean } = {},
) {
  const { rows } = await pool.query(
    `INSERT INTO images (board_id, slot, sha256, name, width, height, uploaded_by, missing)
     VALUES ($1,$2,$3,'img',200,100,'tester',$4) RETURNING id`,
    [boardId, slot, sha256, !!opts.missing],
  );
  return rows[0].id as string;
}

function paintSquare(hue: number): Buffer {
  const size = 400;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = `hsl(${hue}, 70%, 50%)`;
  ctx.fillRect(0, 0, size, size);
  return canvas.encodeSync('png');
}

describe('GET /images/:id/preview', () => {
  test('a synthetic image (ladder page, no original) previews as a 128px PNG', async () => {
    const ts = Date.now();
    const owner = await signUpOrIn(`preview-synth-${ts}@example.test`, 'owner');
    const group = withId(
      (await owner.post('/groups', { name: `Preview-Synth-${ts}` })).buf,
    );
    const board = withId(
      (
        await owner.post(`/groups/${group.id}/boards`, {
          name: 'B',
          open: true,
        })
      ).buf,
    );
    const boardId = board.id;

    const slot = 0;
    const sha256 = `sha-preview-synth-${ts}`;
    const imageId = await makeImage(boardId, slot, sha256);

    // Paint the ladder (8/32/128) without ever writing an original — this
    // is exactly the synthetic million-image board's own shape.
    const png = paintSquare(120);
    const decoded = await loadImage(png);
    await paintLadder(boardId, slot, decoded, decoded.width, decoded.height);
    expect(existsSync(originalPath(boardId, sha256))).toBe(false);

    const res = await owner.get(`/images/${imageId}/preview`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toBe('private, max-age=300');

    const img = await loadImage(res.buf);
    expect(img.width).toBe(128);
    expect(img.height).toBe(128);
  });

  test('an image with a real original previews scaled to <=1024px and caches once', async () => {
    const ts = Date.now();
    const owner = await signUpOrIn(`preview-orig-${ts}@example.test`, 'owner');
    const group = withId(
      (await owner.post('/groups', { name: `Preview-Orig-${ts}` })).buf,
    );
    const board = withId(
      (
        await owner.post(`/groups/${group.id}/boards`, {
          name: 'B',
          open: true,
        })
      ).buf,
    );
    const boardId = board.id;

    const sha256 = `sha-preview-orig-${ts}`;
    const imageId = await makeImage(boardId, 0, sha256);

    // A big original (2000x1000): the preview must scale it down so the
    // longer side is at most 1024, never upscale a small one.
    const big = createCanvas(2000, 1000);
    big.getContext('2d').fillRect(0, 0, 2000, 1000);
    const path = originalPath(boardId, sha256);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, big.encodeSync('png'));

    expect(existsSync(previewPath(boardId, sha256))).toBe(false);
    const res = await owner.get(`/images/${imageId}/preview`);
    expect(res.status).toBe(200);
    const img = await loadImage(res.buf);
    expect(img.width).toBe(1024);
    expect(img.height).toBe(512);
    expect(existsSync(previewPath(boardId, sha256))).toBe(true);

    // Second request reads the cache — same bytes, not a re-decode.
    const cached = await owner.get(`/images/${imageId}/preview`);
    expect(cached.status).toBe(200);
    expect(cached.buf.equals(res.buf)).toBe(true);
  });

  test('a missing image 404s regardless of what is on disk', async () => {
    const ts = Date.now();
    const owner = await signUpOrIn(
      `preview-missing-${ts}@example.test`,
      'owner',
    );
    const group = withId(
      (await owner.post('/groups', { name: `Preview-Missing-${ts}` })).buf,
    );
    const board = withId(
      (
        await owner.post(`/groups/${group.id}/boards`, {
          name: 'B',
          open: true,
        })
      ).buf,
    );
    const boardId = board.id;

    const slot = 0;
    const sha256 = `sha-preview-missing-${ts}`;
    const imageId = await makeImage(boardId, slot, sha256, { missing: true });
    const decoded = await loadImage(paintSquare(200));
    await paintLadder(boardId, slot, decoded, decoded.width, decoded.height);

    const res = await owner.get(`/images/${imageId}/preview`);
    expect(res.status).toBe(404);
  });
});
