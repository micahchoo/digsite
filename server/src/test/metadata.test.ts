// CONTEXT.md "File metadata" (boards/metadata.ts): everything a file carries
// about itself, as a person reads it, kept after the first read.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ImageMetadata } from '@digsite/shared/api';
import sharp from 'sharp';
import { createHttpServer } from '../app.ts';
import { readable, toGroups } from '../boards/metadata.ts';
import { pool } from '../db/pool.ts';
import { drain } from '../worker/index.ts';

describe('readable', () => {
  test('keeps what a person reads and drops bytes', () => {
    expect(readable('Canon\0')).toBe('Canon');
    expect(readable(new Uint8Array([1, 2]))).toBeUndefined();
    // Local fields in, local fields out: the camera's wall time, whatever
    // zone the server runs in.
    expect(readable(new Date(2024, 5, 1, 18, 4, 59))).toBe('2024-06-01 18:04:59');
    expect(readable(new Date(2024, 5, 1))).toBe('2024-06-01');
    expect(readable([1, 2, 3])).toBe('1, 2, 3');
    expect(readable('\u0001\u0002binary')).toBeUndefined();
    expect(readable(Number.NaN)).toBeUndefined();
    expect(readable({ Rating: 4, Label: 'Keep' })).toBe(
      'Rating: 4; Label: Keep',
    );
  });

  test('groups keep their names and lose their blobs', () => {
    expect(
      toGroups({
        ifd0: { Make: 'Canon', MakerNote: 'x', PrintIM: new Uint8Array(4) },
        exif: { ISO: 400, ExposureTime: 0.004 },
        ifd1: { ThumbnailOffset: 1 },
      }),
    ).toEqual({
      ifd0: { Make: 'Canon' },
      exif: { ISO: 400, ExposureTime: 0.004 },
    });
  });
});

let server: Server;
let base = '';
beforeAll(async () => {
  server = createHttpServer();
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(
  () =>
    new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    }),
);

describe('GET /images/:id/metadata', () => {
  test('reads the file once, says what it is, and keeps it', async () => {
    const ts = Date.now();
    let cookie = '';
    const req = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: {
          Origin: base,
          cookie,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0] ?? '';
      return res;
    };
    await req('POST', '/api/auth/sign-up/email', {
      email: `meta-${ts}@example.test`,
      password: 'password1234',
      name: 'Ada',
    });
    const group = (await (
      await req('POST', '/groups', { name: `M-${ts}` })
    ).json()) as { id: string };
    const board = (await (
      await req('POST', `/groups/${group.id}/boards`, { name: 'B', open: true })
    ).json()) as { id: string };
    const jpeg = await sharp({
      create: { width: 32, height: 24, channels: 3, background: '#a33' },
    })
      .jpeg()
      .withExif({
        IFD0: { Make: 'Canon', Model: 'Canon EOS R5', Artist: 'Ada Field' },
        IFD2: {
          DateTimeOriginal: '2024:06:01 18:04:59',
          ISOSpeedRatings: '400',
        },
      })
      .toBuffer();
    const form = new FormData();
    form.append('files', new Blob([jpeg]), 'north.jpg');
    const up = await fetch(`${base}/boards/${board.id}/images?wait=0`, {
      method: 'POST',
      headers: { Origin: base, cookie },
      body: form,
    });
    const [{ id }] = (await up.json()) as { id: string }[];
    await drain();

    const meta = (await (
      await req('GET', `/images/${id}/metadata`)
    ).json()) as ImageMetadata;
    expect(meta.file).toMatchObject({
      format: 'jpeg',
      bytes: jpeg.length,
      width: 32,
      height: 24,
      uploadedBy: 'Ada',
      source: null,
      derivedFrom: null,
    });
    expect(meta.groups.ifd0).toMatchObject({
      Make: 'Canon',
      Artist: 'Ada Field',
    });
    expect(meta.groups.exif?.DateTimeOriginal).toBe('2024-06-01 18:04:59');
    const { rows } = await pool.query(
      'SELECT metadata FROM images WHERE id = $1',
      [id],
    );
    expect(rows[0].metadata.groups.ifd0.Make).toBe('Canon');
  });
});
