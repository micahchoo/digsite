// Roadmap item 1: a sheet's room spans API processes. Two HTTP servers in
// one test process each carry their own Socket.IO server and Postgres
// adapter, which is exactly what two API processes are to each other: an
// edit made through one reaches a peer on the other, and presence lists
// both.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type Socket, io } from 'socket.io-client';
import { createHttpServer } from '../app.ts';
import { pool } from '../db/pool.ts';

let a: Server;
let b: Server;
let baseA = '';
let baseB = '';

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

beforeAll(async () => {
  a = createHttpServer();
  b = createHttpServer();
  baseA = await listen(a);
  baseB = await listen(b);
});

afterAll(async () => {
  await close(a);
  await close(b);
});

async function post(cookie: string, path: string, json: unknown) {
  const res = await fetch(`${baseA}${path}`, {
    method: 'POST',
    headers: { Origin: baseA, cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(json),
  });
  return { res, json: await res.json() };
}

async function join(base: string, cookie: string, sheetId: string) {
  const socket = io(base, {
    autoConnect: false,
    extraHeaders: { cookie },
    transports: ['websocket'],
  });
  const joined = new Promise<void>((resolve, reject) => {
    socket.once('joined', () => resolve());
    socket.once('join-denied', reject);
    socket.once('connect_error', reject);
  });
  socket.connect();
  socket.once('connect', () => socket.emit('join', { sheetId }));
  await joined;
  return socket;
}

function next<T>(socket: Socket, event: string, test: (p: T) => boolean) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${event}`)), 5_000);
    const on = (payload: T) => {
      if (!test(payload)) return;
      clearTimeout(timer);
      socket.off(event, on);
      resolve(payload);
    };
    socket.on(event, on);
  });
}

describe('sheet rooms across API processes', () => {
  test('an edit through one server reaches a peer on the other; presence lists both', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const signUp = await fetch(`${baseA}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { Origin: baseA, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `rooms-${suffix}@example.test`,
        password: 'password1234',
        name: 'Owner',
      }),
    });
    const cookie = signUp.headers.get('set-cookie')?.split(';')[0] ?? '';
    const group = (await post(cookie, '/groups', { name: `Rooms ${suffix}` }))
      .json as { id: string };
    const board = (
      await post(cookie, `/groups/${group.id}/boards`, {
        name: 'Board',
        open: true,
      })
    ).json as { id: string };
    const { rows } = await pool.query(
      `INSERT INTO images (board_id, slot, sha256, name, width, height, uploaded_by)
       VALUES ($1, 0, $2, 'one', 100, 100, 'tester') RETURNING id`,
      [board.id, `rooms-${suffix}`],
    );
    const sheet = (
      await post(cookie, `/boards/${board.id}/sheets`, {
        name: 'Across',
        imageIds: [rows[0].id],
      })
    ).json as { id: string };

    const onA = await join(baseA, cookie, sheet.id);
    const seesTwo = next<{ peers: unknown[] }>(
      onA,
      'peers',
      (p) => p.peers.length === 2,
    );
    const onB = await join(baseB, cookie, sheet.id);
    await seesTwo;

    const edit = [{ id: 'across-edit', version: 1, versionNonce: 1 }];
    const arrives = next<{ elements: { id: string }[] }>(onB, 'scene', (p) =>
      p.elements.some((e) => e.id === 'across-edit'),
    );
    onA.emit('scene', { elements: edit });
    expect((await arrives).elements[0]?.id).toBe('across-edit');

    // A real scene is larger than a NOTIFY carries (8,000 bytes); the
    // adapter parks it in socket_io_attachments (0021).
    const big = [
      {
        id: 'across-big',
        version: 2,
        versionNonce: 2,
        note: 'x'.repeat(40_000),
      },
    ];
    const bigArrives = next<{ elements: { id: string; note?: string }[] }>(
      onB,
      'scene',
      (p) => p.elements.some((e) => e.id === 'across-big'),
    );
    onA.emit('scene', { elements: big });
    expect((await bigArrives).elements[0]?.note?.length).toBe(40_000);

    const seesOne = next<{ peers: unknown[] }>(
      onA,
      'peers',
      (p) => p.peers.length === 1,
    );
    onB.disconnect();
    await seesOne;
    onA.disconnect();
  }, 20_000);
});
