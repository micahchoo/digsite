import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHttpServer } from '../app.ts';
import { pool } from '../db/pool.ts';

let server: Server;
let base = '';

beforeAll(async () => {
  server = createHttpServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as AddressInfo;
  base = `http://127.0.0.1:${address.port}`;
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
    json?: unknown,
  ): Promise<{ status: number; json: unknown }> {
    const headers: Record<string, string> = { Origin: base };
    if (this.cookie) headers.cookie = this.cookie;
    if (json !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${base}${path}`, {
      method,
      headers,
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0] ?? '';
    const text = await response.text();
    return {
      status: response.status,
      json: text ? JSON.parse(text) : null,
    };
  }

  post(path: string, body?: unknown) {
    return this.raw('POST', path, body);
  }

  get(path: string) {
    return this.raw('GET', path);
  }

  delete(path: string) {
    return this.raw('DELETE', path);
  }
}

function idOf(value: unknown): string {
  return (value as { id: string }).id;
}

async function makeImage(boardId: string, slot: number, nonce: string) {
  const { rows } = await pool.query(
    `INSERT INTO images (board_id, slot, sha256, name, width, height, uploaded_by)
     VALUES ($1, $2, $3, $4, 120, 80, 'concurrency-test') RETURNING id`,
    [boardId, slot, `selection-concurrency-${nonce}`, `image-${slot}`],
  );
  return rows[0].id as string;
}

describe('add-to-sheet concurrency', () => {
  test('serializes overlapping additions and preserves the 150-image cap', async () => {
    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const owner = new Session();
    const signUp = await owner.post('/api/auth/sign-up/email', {
      email: `selection-concurrency-${nonce}@example.test`,
      password: 'password1234',
      name: 'concurrency test',
    });
    expect(signUp.status).toBe(200);

    const groupResponse = await owner.post('/groups', {
      name: `Selection concurrency ${nonce}`,
    });
    expect(groupResponse.status).toBe(200);
    const groupId = idOf(groupResponse.json);
    const boardResponse = await owner.post(`/groups/${groupId}/boards`, {
      name: 'Concurrent additions',
      open: true,
    });
    expect(boardResponse.status).toBe(200);
    const boardId = idOf(boardResponse.json);

    let boardDeleted = false;
    try {
      const ids: string[] = [];
      for (let slot = 0; slot < 153; slot++) {
        ids.push(await makeImage(boardId, slot, `${nonce}-${slot}`));
      }
      await pool.query('UPDATE boards SET image_count = 153 WHERE id = $1', [
        boardId,
      ]);

      const sheetResponse = await owner.post(`/boards/${boardId}/sheets`, {
        name: 'Near capacity',
        imageIds: ids.slice(0, 140),
      });
      expect(sheetResponse.status).toBe(200);
      const sheetId = idOf(sheetResponse.json);

      const endpoint = `/boards/${boardId}/sheets/${sheetId}/images`;
      const malformed = await owner.post(endpoint, {
        imageIds: ['not-a-uuid'],
      });
      expect(malformed.status).toBe(400);

      // Every request races for one shared id plus its own id. There are 13
      // candidate ids and only 10 free slots: the route must serialize the
      // membership read, cap calculation, inserts and snapshot merge.
      const shared = ids[140];
      if (!shared) throw new Error('missing shared image');
      const calls = Array.from({ length: 12 }, (_, index) => {
        const unique = ids[141 + index];
        if (!unique) throw new Error(`missing candidate image ${index}`);
        return owner.post(endpoint, { imageIds: [shared, unique] });
      });
      const responses = await Promise.all(calls);
      expect(responses.map((response) => response.status)).toEqual(
        Array(12).fill(200),
      );

      const { rows: memberships } = await pool.query(
        'SELECT image_id FROM sheet_images WHERE sheet_id = $1',
        [sheetId],
      );
      expect(memberships).toHaveLength(150);

      const elementsResponse = await owner.get(`/sheets/${sheetId}/elements`);
      expect(elementsResponse.status).toBe(200);
      const elements = (
        elementsResponse.json as {
          elements: { customData?: { kind?: string; imageId?: string } }[];
        }
      ).elements;
      const imageIds = elements
        .filter((element) => element.customData?.kind === 'image')
        .map((element) => element.customData?.imageId);
      expect(imageIds).toHaveLength(150);
      expect(new Set(imageIds).size).toBe(150);
      expect(new Set(imageIds)).toEqual(
        new Set(memberships.map((row) => row.image_id as string)),
      );
      expect(ids.slice(0, 140).every((id) => imageIds.includes(id))).toBe(true);

      const removed = await owner.delete(`/boards/${boardId}`);
      expect(removed.status).toBe(200);
      boardDeleted = true;
    } finally {
      if (!boardDeleted) await owner.delete(`/boards/${boardId}`);
    }
  });
});
