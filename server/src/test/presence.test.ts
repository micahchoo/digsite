// boards/presence.ts across two API processes (two HTTP servers, each with
// its own Socket.IO server and Postgres adapter).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type Socket, io } from 'socket.io-client';
import { createHttpServer } from '../app.ts';

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

function connect(base: string, cookie: string): Promise<Socket> {
  const socket = io(base, {
    autoConnect: false,
    extraHeaders: { cookie },
    transports: ['websocket'],
  });
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
    socket.connect();
  });
}

async function signUp(name: string): Promise<string> {
  const res = await fetch(`${baseA}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { Origin: baseA, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `presence-${name}-${Date.now()}-${Math.random()}@example.test`,
      password: 'password1234',
      name,
    }),
  });
  return res.headers.get('set-cookie')?.split(';')[0] ?? '';
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

type Presence = {
  full: boolean;
  viewers: {
    key: string;
    name: string;
    colour: string;
    hover: string | null;
    selected: string[];
  }[];
};

describe('presence on a board, across API processes', () => {
  test('viewers see each other, changes arrive throttled, a leave is seen, an outsider is refused', async () => {
    const cookie = await signUp('Ada');
    const group = (await post(cookie, '/groups', { name: `P ${Date.now()}` }))
      .json as { id: string };
    const board = (
      await post(cookie, `/groups/${group.id}/boards`, {
        name: 'B',
        open: true,
      })
    ).json as { id: string };

    const onA = await connect(baseA, cookie);
    const firstList = next<Presence>(onA, 'presence', (p) => p.full);
    onA.emit('board-join', { boardId: board.id });
    expect((await firstList).viewers).toHaveLength(1);

    const seesTwo = next<Presence>(
      onA,
      'presence',
      (p) => p.full && p.viewers.length === 2,
    );
    const onB = await connect(baseB, cookie);
    onB.emit('board-join', { boardId: board.id });
    const two = await seesTwo;
    expect(two.viewers.map((v) => v.name)).toEqual(['Ada', 'Ada']);
    expect(two.viewers[0]?.colour).toMatch(/^hsl\(/);

    // A change from B, through the other process, is one viewer.
    const change = next<Presence>(
      onA,
      'presence',
      (p) => !p.full && p.viewers[0]?.hover === 'img-1',
    );
    onB.emit('board-presence', {
      hover: 'img-1',
      selected: ['img-1', 'img-2'],
    });
    const changed = await change;
    expect(changed.viewers).toHaveLength(1);
    expect(changed.viewers[0]).toMatchObject({
      key: onB.id,
      selected: ['img-1', 'img-2'],
    });

    // At most 5 a second: of 20 sent at once, no more than 5 arrive.
    let arrived = 0;
    const count = (p: Presence) => {
      if (!p.full) arrived++;
    };
    onA.on('presence', count);
    for (let i = 0; i < 20; i++) {
      onB.emit('board-presence', { hover: `burst-${i}`, selected: [] });
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    onA.off('presence', count);
    expect(arrived).toBeLessThanOrEqual(5);

    // B goes: A's list is one again.
    const seesOne = next<Presence>(
      onA,
      'presence',
      (p) => p.full && p.viewers.length === 1,
    );
    onB.disconnect();
    await seesOne;

    // Someone outside the group is refused.
    const outsider = await connect(baseA, await signUp('Eve'));
    const denied = new Promise<{ reason: string }>((resolve) =>
      outsider.once('board-join-denied', resolve),
    );
    outsider.emit('board-join', { boardId: board.id });
    expect((await denied).reason).toBeTruthy();
    outsider.disconnect();
    onA.disconnect();
  });
});
