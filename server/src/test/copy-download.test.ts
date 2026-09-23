import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// POST /boards/:id/images/copy and GET /boards/:id/images/download over
// HTTP. A copy goes through intake (names, properties and kept camera
// sources travel; a second copy is skipped with where each picture is).
// A download is a zip an ordinary reader (Python's zipfile) opens, holding
// every original byte for byte, names made unique, caps refused first.
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createHttpServer } from '../app.ts';
import { pool } from '../db/pool.ts';

const HEIC = join(import.meta.dir, 'fixtures', 'split-64x48.heic');
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
  const res = await fetch(`${base}${path}`, { method, headers, body: payload });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0] ?? '';
  return res;
}

const png = (hue: number) =>
  sharp({
    create: {
      width: 16,
      height: 16,
      channels: 3,
      background: { r: hue, g: 50, b: 90 },
    },
  })
    .png()
    .toBuffer();

describe('copy and download', () => {
  test('copy carries names, properties and sources once; download is a real zip', async () => {
    const ts = Date.now();
    await request('POST', '/api/auth/sign-up/email', {
      email: `copy-${ts}@example.test`,
      password: 'password1234',
      name: 'owner',
    });
    const group = (await (
      await request('POST', '/groups', { name: `Copy-${ts}` })
    ).json()) as { id: string };
    const board = async (name: string) =>
      (
        (await (
          await request('POST', `/groups/${group.id}/boards`, {
            name,
            open: true,
          })
        ).json()) as { id: string }
      ).id;
    const from = await board('From');
    const to = await board('To');

    const pngA = await png(10);
    const pngB = await png(200);
    const form = new FormData();
    form.append('files', new File([pngA], 'same.png'));
    form.append('files', new File([pngB], 'same.png'));
    form.append(
      'files',
      new File([await Bun.file(HEIC).arrayBuffer()], 'IMG_1.HEIC'),
    );
    form.append(
      'properties',
      JSON.stringify([{ site: 'A' }, { site: 'B' }, {}]),
    );
    const uploaded = (await (
      await request('POST', `/boards/${from}/images?wait=0`, form)
    ).json()) as { id: string }[];
    const ids = uploaded.map((u) => u.id);

    const first = await request('POST', `/boards/${to}/images/copy`, {
      fromBoardId: from,
      imageIds: ids,
    });
    expect(first.status).toBe(202);
    const copied = (await first.json()) as {
      images: { id: string }[];
      skipped: unknown[];
    };
    expect([copied.images.length, copied.skipped]).toEqual([3, []]);
    const { rows } = await pool.query(
      'SELECT name, properties, source_format FROM images WHERE board_id = $1 ORDER BY slot',
      [to],
    );
    expect(
      rows.map((r) => [r.name, r.properties.site ?? null, r.source_format]),
    ).toEqual([
      ['same.png', 'A', null],
      ['same.png', 'B', null],
      ['IMG_1.HEIC', null, 'HEIC'],
    ]);

    const again = (await (
      await request('POST', `/boards/${to}/images/copy`, {
        fromBoardId: from,
        imageIds: ids,
      })
    ).json()) as { images: unknown[]; skipped: { reason: string }[] };
    expect(again.images).toEqual([]);
    expect(again.skipped.map((s) => s.reason)).toEqual([
      'already on this board as same.png',
      'already on this board as same.png',
      'already on this board as IMG_1.HEIC',
    ]);

    // The download, read by an independent zip reader.
    const zip = await request(
      'GET',
      `/boards/${from}/images/download?ids=${ids.join(',')}`,
    );
    expect(zip.status).toBe(200);
    expect(zip.headers.get('content-type')).toBe('application/zip');
    const dir = await mkdtemp(join(tmpdir(), 'zip-'));
    try {
      const path = join(dir, 'd.zip');
      await Bun.write(path, await zip.arrayBuffer());
      const read = Bun.spawnSync([
        'python3',
        '-c',
        `import zipfile,sys,hashlib
z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None
for i in z.infolist(): print(i.filename, hashlib.sha256(z.read(i)).hexdigest())`,
        path,
      ]);
      expect(read.exitCode).toBe(0);
      const listed = read.stdout.toString().trim().split('\n');
      const sha = (b: Buffer) =>
        new Bun.CryptoHasher('sha256').update(b).digest('hex');
      expect(listed.slice(0, 2)).toEqual([
        `same.png ${sha(pngA)}`,
        `same (2).png ${sha(pngB)}`,
      ]);
      expect(listed[2]?.startsWith('IMG_1.HEIC ')).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    // The caller's stored selection, which a URL could not carry at this
    // size: past the cap, refused before a byte is sent.
    const who = (await (
      await request('GET', '/api/auth/get-session')
    ).json()) as {
      user: { id: string };
    };
    await pool.query(
      `INSERT INTO board_selections (user_id, board_id, image_ids, updated_at)
       VALUES ($1, $2, $3, now())`,
      [
        who.user.id,
        from,
        Array.from({ length: 501 }, () => crypto.randomUUID()),
      ],
    );
    const refused = await request(
      'GET',
      `/boards/${from}/images/download?selection=1`,
    );
    expect(refused.status).toBe(413);
    expect(await refused.json()).toMatchObject({
      reason: 'download',
      maxFiles: 500,
    });
  });
});
