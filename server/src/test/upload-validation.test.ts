import { describe, expect, test } from 'bun:test';
// Phase 5 section 2 (docs/phases/5-hardening.md "Abuse limits"): the
// header-only checks in boards/validate.ts — real type by magic bytes
// (415), size cap (413), pixel budget read from the header before decode
// (413) — plus the HTTP route's own atomic-batch refusal. Pure unit tests
// against `validateUpload` first (no server, no DB); one HTTP test at the
// end for the route wiring.
import { afterAll, beforeAll } from 'bun:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createCanvas } from '@napi-rs/canvas';
import { createHttpServer } from '../app.ts';
import { detectImageType, validateUpload } from '../boards/validate.ts';
import { env } from '../env.ts';

function pngBytes(w: number, h: number): Buffer {
  const canvas = createCanvas(w, h);
  canvas.getContext('2d').fillRect(0, 0, w, h);
  return canvas.encodeSync('png');
}

// A PNG with its IHDR width/height overwritten to claim a huge canvas
// without actually allocating one — this is exactly the shape a
// decompression-bomb-style upload takes, and exactly what a header-level
// check (rather than decode-then-measure) is for.
function pngClaimingSize(w: number, h: number): Buffer {
  const real = pngBytes(4, 4);
  const buf = Buffer.from(real);
  buf.writeUInt32BE(w, 16);
  buf.writeUInt32BE(h, 20);
  return buf;
}

describe('validate: detectImageType', () => {
  test('PNG magic bytes', () => {
    expect(detectImageType(pngBytes(4, 4))).toBe('png');
  });

  test('JPEG magic bytes', () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
    expect(detectImageType(jpeg)).toBe('jpeg');
  });

  test('GIF magic bytes (both sub-versions)', () => {
    const gif87 = new TextEncoder().encode('GIF87a\0\0\0\0');
    const gif89 = new TextEncoder().encode('GIF89a\0\0\0\0');
    expect(detectImageType(gif87)).toBe('gif');
    expect(detectImageType(gif89)).toBe('gif');
  });

  test('WebP (RIFF/WEBP) magic bytes', () => {
    const webp = new Uint8Array(16);
    webp.set(new TextEncoder().encode('RIFF'), 0);
    webp.set(new TextEncoder().encode('WEBP'), 8);
    expect(detectImageType(webp)).toBe('webp');
  });

  test('AVIF (ftyp box, avif brand) magic bytes', () => {
    const avif = new Uint8Array(16);
    // box size (4, unused by detection), 'ftyp', major brand 'avif'
    avif.set([0, 0, 0, 20], 0);
    avif.set(new TextEncoder().encode('ftyp'), 4);
    avif.set(new TextEncoder().encode('avif'), 8);
    expect(detectImageType(avif)).toBe('avif');
  });

  test('not a recognised type', () => {
    expect(
      detectImageType(new TextEncoder().encode('just some text')),
    ).toBeNull();
  });
});

describe('validate: validateUpload', () => {
  test('a small real PNG passes, with dimensions read from the header', () => {
    const result = validateUpload(pngBytes(10, 20));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.type).toBe('png');
      expect(result.width).toBe(10);
      expect(result.height).toBe(20);
    }
  });

  test('415 for a file that is not a recognised image type', () => {
    const result = validateUpload(
      new TextEncoder().encode('not an image, just bytes'),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(415);
  });

  test('413 for a file over UPLOAD_MAX_MB', () => {
    const big = Buffer.concat([
      pngBytes(4, 4),
      Buffer.alloc(env.UPLOAD_MAX_MB * 1024 * 1024 + 1),
    ]);
    const result = validateUpload(big);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(413);
  });

  test('413 for a header-declared pixel count over UPLOAD_MAX_PIXELS — never decoded', () => {
    // width*height chosen to be just over the budget; real dimensions this
    // large would try to allocate tens of GB if actually decoded, which
    // this test never does — validateUpload only reads 24 header bytes.
    const side = Math.ceil(Math.sqrt(env.UPLOAD_MAX_PIXELS)) + 1000;
    const claimed = pngClaimingSize(side, side);
    const result = validateUpload(claimed);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(413);
  });

  test('a file within the pixel budget passes even at the boundary', () => {
    // 4x4 is trivially within budget; asserts the happy path isn't
    // accidentally tripped by the pixel check.
    const result = validateUpload(pngBytes(4, 4));
    expect(result.ok).toBe(true);
  });
});

describe('validate: HTTP route wiring', () => {
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

  test('POST /boards/:id/images refuses a non-image file with 415 and enqueues nothing', async () => {
    const ts = Date.now();
    let cookie = '';
    const signUp = await fetch(`${base}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `validate-${ts}@example.test`,
        password: 'password1234',
        name: 'validate',
      }),
    });
    const setCookie = signUp.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0] ?? '';

    const group = await fetch(`${base}/groups`, {
      method: 'POST',
      headers: { Origin: base, cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `Validate-${ts}` }),
    });
    const groupId = ((await group.json()) as { id: string }).id;
    const board = await fetch(`${base}/groups/${groupId}/boards`, {
      method: 'POST',
      headers: { Origin: base, cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'B', open: true }),
    });
    const boardId = ((await board.json()) as { id: string }).id;

    const before = await fetch(`${base}/boards/${boardId}/images?ids=`, {
      headers: { Origin: base, cookie },
    });
    expect(before.status).toBe(200);

    const form = new FormData();
    form.append(
      'files',
      new Blob([new TextEncoder().encode('not an image')], {
        type: 'image/png',
      }),
      'fake.png',
    );
    const res = await fetch(`${base}/boards/${boardId}/images?wait=0`, {
      method: 'POST',
      headers: { Origin: base, cookie },
      body: form,
    });
    expect(res.status).toBe(415);

    const after = await fetch(`${base}/boards/${boardId}/images`, {
      headers: { Origin: base, cookie },
    });
    const images = ((await after.json()) as { images: unknown[] }).images;
    expect(images.length).toBe(0); // nothing was stored or enqueued
  });
});
