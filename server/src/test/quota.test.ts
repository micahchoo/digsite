import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// storage/quota.ts: a group pays once for each object its boards store,
// is refused past its quota on every path, gets bytes back on delete, and
// a folder import stops at the quota and resumes after it is raised.
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createHttpServer } from '../app.ts';
import {
  folderImport,
  resumeFolderImport,
  startFolderImport,
} from '../boards/folder-import.ts';
import { uploadOne } from '../boards/upload.ts';
import { pool } from '../db/pool.ts';
import { env } from '../env.ts';
import { QuotaExceeded, reserve, storageOf } from '../storage/quota.ts';
import { drain } from '../worker/index.ts';

const png = (hue: number) =>
  sharp({
    create: {
      width: 64,
      height: 64,
      channels: 3,
      background: { r: hue, g: 120, b: 30 },
    },
  })
    .png({ compressionLevel: 0 })
    .toBuffer();

async function groupBoard(quota: number | null) {
  const orgId = `org-quota-${Date.now()}-${Math.random()}`;
  const { rows } = await pool.query(
    `INSERT INTO boards (org_id, name, open, created_by)
     VALUES ($1, 'q', true, 'tester') RETURNING id`,
    [orgId],
  );
  await pool.query(
    'INSERT INTO group_storage (org_id, quota_bytes) VALUES ($1, $2)',
    [orgId, quota],
  );
  return { orgId, boardId: rows[0].id as string };
}

describe('storage quota', () => {
  test('an object is paid for once, however many images share it', async () => {
    const { orgId, boardId } = await groupBoard(null);
    const bytes = new Uint8Array(await png(10));
    await uploadOne(boardId, 'tester', 'a.png', bytes);
    await uploadOne(boardId, 'tester', 'again.png', bytes);
    expect(await storageOf(orgId)).toEqual({
      usedBytes: bytes.length,
      quotaBytes: null,
    });
  });

  test('past the quota a file is refused and nothing is charged', async () => {
    const small = new Uint8Array(await png(20));
    const { orgId, boardId } = await groupBoard(small.length + 10);
    await uploadOne(boardId, 'tester', 'a.png', small);
    const other = new Uint8Array(await png(200));
    await expect(
      uploadOne(boardId, 'tester', 'b.png', other),
    ).rejects.toBeInstanceOf(QuotaExceeded);
    expect((await storageOf(orgId)).usedBytes).toBe(small.length);
  });

  test('reservations made at once never pass the quota together', async () => {
    const { orgId, boardId } = await groupBoard(1000);
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => reserve(boardId, 100)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(10);
    expect((await storageOf(orgId)).usedBytes).toBe(1000);
  });
});

describe('quota over HTTP and in a folder import', () => {
  let server: Server;
  let base = '';
  let cookie = '';
  let root = '';
  beforeAll(async () => {
    server = createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    root = await mkdtemp(join(tmpdir(), 'quota-import-'));
  });
  afterAll(async () => {
    env.IMPORT_ROOTS = [];
    await rm(root, { recursive: true, force: true });
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  });

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

  test('an upload past the quota answers 413 with the numbers; the group says how full it is', async () => {
    const ts = Date.now();
    await request('POST', '/api/auth/sign-up/email', {
      email: `quota-${ts}@example.test`,
      password: 'password1234',
      name: 'owner',
    });
    const group = (await (
      await request('POST', '/groups', { name: `Quota-${ts}` })
    ).json()) as { id: string };
    const board = (await (
      await request('POST', `/groups/${group.id}/boards`, {
        name: 'B',
        open: true,
      })
    ).json()) as { id: string };
    await pool.query(
      `INSERT INTO group_storage (org_id, quota_bytes) VALUES ($1, 100)
       ON CONFLICT (org_id) DO UPDATE SET quota_bytes = 100`,
      [group.id],
    );
    const form = new FormData();
    form.append('files', new File([await png(90)], 'big.png'));
    const res = await request(
      'POST',
      `/boards/${board.id}/images?wait=0`,
      form,
    );
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      error: 'group storage is full',
      reason: 'quota',
      usedBytes: 0,
      quotaBytes: 100,
      accepted: [],
    });
    // A batch that crosses the line partway keeps, and names, what landed.
    const first = await png(40);
    await pool.query(
      'UPDATE group_storage SET quota_bytes = $2 WHERE org_id = $1',
      [group.id, first.length + 1],
    );
    const batch = new FormData();
    batch.append('files', new File([first], 'fits.png'));
    batch.append('files', new File([await png(41)], 'over.png'));
    const partway = await request(
      'POST',
      `/boards/${board.id}/images?wait=0`,
      batch,
    );
    expect(partway.status).toBe(413);
    const refused = (await partway.json()) as {
      accepted: { name: string; id: string }[];
    };
    expect(refused.accepted.map((a) => a.name)).toEqual(['fits.png']);
    const { rows: landed } = await pool.query(
      'SELECT id FROM images WHERE board_id = $1',
      [board.id],
    );
    expect(landed.map((r) => r.id)).toEqual([refused.accepted[0]?.id]);
    await pool.query('DELETE FROM images WHERE board_id = $1', [board.id]);
    await pool.query(
      'UPDATE group_storage SET used_bytes = 0, quota_bytes = 100 WHERE org_id = $1',
      [group.id],
    );

    const detail = await (await request('GET', `/groups/${group.id}`)).json();
    expect(detail).toMatchObject({
      id: group.id,
      storage: { usedBytes: 0, quotaBytes: 100 },
    });

    // A folder import stops at the quota, says why, and resumes once the
    // quota is raised.
    const one = await png(1);
    const two = await png(2);
    await Bun.write(join(root, 'a.png'), one);
    await Bun.write(join(root, 'b.png'), two);
    env.IMPORT_ROOTS = [root];
    await pool.query(
      'UPDATE group_storage SET quota_bytes = $2 WHERE org_id = $1',
      [group.id, one.length + 1],
    );
    const started = await startFolderImport(board.id, 'owner', root);
    await drain();
    const stopped = await folderImport(board.id, started.id);
    expect(stopped).toMatchObject({ state: 'stopped', imported: 1 });
    expect(stopped?.stopReason).toContain('group storage is full');
    await pool.query(
      'UPDATE group_storage SET quota_bytes = NULL WHERE org_id = $1',
      [group.id],
    );
    expect(await resumeFolderImport(board.id, started.id)).toBe(true);
    await drain();
    expect(await folderImport(board.id, started.id)).toMatchObject({
      state: 'done',
      imported: 2,
      stopReason: null,
    });

    // Deleting an image gives its bytes back.
    const before = (await storageOf(group.id)).usedBytes;
    const { rows } = await pool.query(
      "SELECT id FROM images WHERE board_id = $1 AND name = 'a.png'",
      [board.id],
    );
    expect((await request('DELETE', `/images/${rows[0].id}`)).status).toBe(200);
    expect((await storageOf(group.id)).usedBytes).toBe(before - one.length);
  });
});
