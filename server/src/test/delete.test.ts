import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// docs/phases/3-groups.md section 4 / this task's "Tests" list: deleting a
// board with two sheets and cross-sheet claims leaves no rows referencing
// it and no files; deleting a sheet leaves the other sheet's own copies
// intact and its foreign poll empty of that sheet. Fixture setup goes
// through the real HTTP routes for groups/boards/sheets (same approach as
// access.test.ts) plus direct SQL for images and saveSnapshotAndProject for
// claims (same approach as snapshot.test.ts) — the upload/worker pipeline
// is not this file's concern.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { createHttpServer } from '../app.ts';
import { forceRebuildRank } from '../boards/ranks.ts';
import { pool } from '../db/pool.ts';
import { env } from '../env.ts';
import { saveSnapshotAndProject } from '../sheets/snapshot.ts';

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
  ): Promise<{ status: number; json: unknown }> {
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
    const text = await res.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
    }
    return { status: res.status, json };
  }

  get(path: string) {
    return this.raw('GET', path);
  }
  post(path: string, json?: unknown) {
    return this.raw('POST', path, { json });
  }
  del(path: string) {
    return this.raw('DELETE', path);
  }
}

function withId(json: unknown): { id: string } {
  return json as { id: string };
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
  if (inn.status !== 200) {
    throw new Error(`sign-in failed ${email}: ${inn.status}`);
  }
  return s;
}

async function makeImage(boardId: string, slot: number, name: string) {
  const { rows } = await pool.query(
    `INSERT INTO images (board_id, slot, sha256, name, width, height, uploaded_by)
     VALUES ($1,$2,$3,$4,200,200,'tester') RETURNING id`,
    [boardId, slot, `sha-del-${slot}-${Date.now()}-${Math.random()}`, name],
  );
  return rows[0].id as string;
}

function imageEl(id: string, imageId: string, x: number, y: number) {
  return {
    id,
    type: 'image',
    x,
    y,
    width: 200,
    height: 200,
    isDeleted: false,
    version: 1,
    versionNonce: 1,
    customData: { kind: 'image', imageId },
  };
}

function regionEl(id: string, imageId: string) {
  return {
    id,
    type: 'rectangle',
    x: 20,
    y: 20,
    width: 40,
    height: 40,
    isDeleted: false,
    version: 1,
    versionNonce: 1,
    customData: { kind: 'region', imageId, label: 'find', properties: {} },
  };
}

function edgeEl(id: string, startId: string, endId: string) {
  return {
    id,
    type: 'arrow',
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    isDeleted: false,
    version: 1,
    versionNonce: 1,
    startBinding: { elementId: startId },
    endBinding: { elementId: endId },
    customData: {
      kind: 'edge',
      relation: 'resembles',
      direction: 'forward',
      properties: {},
    },
  };
}

async function countRows(table: string, where: string, arg: string) {
  const { rows } = await pool.query(
    `SELECT COUNT(*) FROM ${table} WHERE ${where}`,
    [arg],
  );
  return Number(rows[0].count);
}

describe('delete', () => {
  test('deleting a board with two sheets and cross-sheet claims leaves no rows and no files', async () => {
    const ts = Date.now();
    const owner = await signUpOrIn(
      `del-board-owner-${ts}@example.test`,
      'owner',
    );
    const group = withId(
      (await owner.post('/groups', { name: `Del-Board-${ts}` })).json,
    );
    const board = withId(
      (
        await owner.post(`/groups/${group.id}/boards`, {
          name: 'DoomedBoard',
          open: true,
        })
      ).json,
    );
    const boardId = board.id;

    const imgX = await makeImage(boardId, 0, 'x');
    const imgY = await makeImage(boardId, 1, 'y');

    // Sheet A owns a region on X and an edge X->Y; sheet B holds both
    // images too, so A's claims are foreign to it.
    const sheetA = withId(
      (
        await owner.post(`/boards/${boardId}/sheets`, {
          name: 'A',
          imageIds: [imgX, imgY],
        })
      ).json,
    );
    const sheetB = withId(
      (
        await owner.post(`/boards/${boardId}/sheets`, {
          name: 'B',
          imageIds: [imgX, imgY],
        })
      ).json,
    );

    await saveSnapshotAndProject(sheetA.id, [
      imageEl('el-img-x', imgX, 0, 0),
      imageEl('el-img-y', imgY, 300, 0),
      regionEl('el-region-x', imgX),
      edgeEl('el-edge-x-y', 'el-img-x', 'el-img-y'),
    ]);

    // Populate board_ranks/board_rank_state, and a queued job, so the
    // delete's cleanup of those has something real to remove.
    await forceRebuildRank(boardId, { key: 'uploaded_at', dir: 'desc' });
    await pool.query(
      `INSERT INTO jobs (kind, payload) VALUES ('materialise', jsonb_build_object('boardId', $1::text, 'sortId', 'uploaded_at.desc'))`,
      [boardId],
    );

    // Real files under DATA_DIR, mirroring what upload/ladder/materialise
    // would have written — the delete route sweeps the whole board
    // directory, not specific files.
    const boardDir = join(env.DATA_DIR, 'boards', boardId);
    mkdirSync(join(boardDir, 'originals'), { recursive: true });
    writeFileSync(join(boardDir, 'originals', 'dummy'), 'not a real png');
    mkdirSync(join(boardDir, 'ladder', '32'), { recursive: true });
    writeFileSync(join(boardDir, 'ladder', '32', 'page-0.png'), 'fake');
    expect(existsSync(boardDir)).toBe(true);

    // Confirm the footprint the delete confirmation would show.
    const footprint = await owner.get(`/boards/${boardId}/footprint`);
    expect(footprint.status).toBe(200);
    expect(footprint.json).toEqual({
      images: 2,
      sheets: 2,
      regions: 1,
      edges: 1,
    });

    const outsider = await signUpOrIn(
      `del-board-outsider-${ts}@example.test`,
      'outsider',
    );
    const denied = await outsider.del(`/boards/${boardId}`);
    expect(denied.status).toBe(403);

    const deleted = await owner.del(`/boards/${boardId}`);
    expect(deleted.status).toBe(200);

    // No rows referencing this board anywhere.
    expect(await countRows('boards', 'id = $1', boardId)).toBe(0);
    expect(await countRows('images', 'board_id = $1', boardId)).toBe(0);
    expect(await countRows('sheets', 'board_id = $1', boardId)).toBe(0);
    expect(await countRows('sheet_images', 'sheet_id = $1', sheetA.id)).toBe(0);
    expect(await countRows('sheet_snapshots', 'sheet_id = $1', sheetA.id)).toBe(
      0,
    );
    expect(await countRows('regions', 'sheet_id = $1', sheetA.id)).toBe(0);
    expect(await countRows('edges', 'sheet_id = $1', sheetA.id)).toBe(0);
    expect(await countRows('board_ranks', 'board_id = $1', boardId)).toBe(0);
    expect(await countRows('board_rank_state', 'board_id = $1', boardId)).toBe(
      0,
    );
    const { rows: jobRows } = await pool.query(
      `SELECT COUNT(*) FROM jobs WHERE payload->>'boardId' = $1`,
      [boardId],
    );
    expect(Number(jobRows[0].count)).toBe(0);

    // No files.
    expect(existsSync(boardDir)).toBe(false);
  });

  test('deleting a sheet leaves the other sheet intact and its foreign poll empty of it', async () => {
    const ts = Date.now();
    const owner = await signUpOrIn(
      `del-sheet-owner-${ts}@example.test`,
      'owner',
    );
    const group = withId(
      (await owner.post('/groups', { name: `Del-Sheet-${ts}` })).json,
    );
    const board = withId(
      (
        await owner.post(`/groups/${group.id}/boards`, {
          name: 'B',
          open: true,
        })
      ).json,
    );
    const boardId = board.id;
    const imgX = await makeImage(boardId, 0, 'x');

    const sheetA = withId(
      (
        await owner.post(`/boards/${boardId}/sheets`, {
          name: 'A',
          imageIds: [imgX],
        })
      ).json,
    );
    const sheetB = withId(
      (
        await owner.post(`/boards/${boardId}/sheets`, {
          name: 'B',
          imageIds: [imgX],
        })
      ).json,
    );

    await saveSnapshotAndProject(sheetA.id, [
      imageEl('el-img-x', imgX, 0, 0),
      regionEl('el-region-x', imgX),
    ]);
    // B holds its own, unrelated region on the same image — this must
    // survive A's deletion untouched.
    await saveSnapshotAndProject(sheetB.id, [
      imageEl('el-img-x-b', imgX, 0, 0),
      regionEl('el-region-x-b', imgX),
    ]);

    const foreignBefore = await owner.get(`/sheets/${sheetB.id}/foreign`);
    expect(foreignBefore.status).toBe(200);
    const beforeRegions = (
      foreignBefore.json as { regions: { sheetId: string }[] }
    ).regions;
    expect(beforeRegions.some((r) => r.sheetId === sheetA.id)).toBe(true);

    const footprint = await owner.get(`/sheets/${sheetA.id}/footprint`);
    expect(footprint.status).toBe(200);
    expect(footprint.json).toEqual({ foreignViews: 1 });

    const deleted = await owner.del(`/sheets/${sheetA.id}`);
    expect(deleted.status).toBe(200);

    expect(await countRows('sheets', 'id = $1', sheetA.id)).toBe(0);
    expect(await countRows('regions', 'sheet_id = $1', sheetA.id)).toBe(0);
    expect(await countRows('sheet_images', 'sheet_id = $1', sheetA.id)).toBe(0);
    expect(await countRows('sheet_snapshots', 'sheet_id = $1', sheetA.id)).toBe(
      0,
    );

    // B's own region survives, and its foreign poll no longer carries
    // anything from A.
    expect(await countRows('regions', 'sheet_id = $1', sheetB.id)).toBe(1);
    const foreignAfter = await owner.get(`/sheets/${sheetB.id}/foreign`);
    expect(foreignAfter.status).toBe(200);
    const afterRegions = (
      foreignAfter.json as { regions: { sheetId: string }[] }
    ).regions;
    expect(afterRegions.some((r) => r.sheetId === sheetA.id)).toBe(false);

    const stillThere = await owner.get(`/sheets/${sheetB.id}`);
    expect(stillThere.status).toBe(200);
  });
});
