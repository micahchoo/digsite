// A committed HTTP Add to sheet must reach existing room members through the
// normal scene protocol, then survive the room's later debounced save.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type Socket, io } from 'socket.io-client';
import { createHttpServer } from '../app.ts';
import { pool } from '../db/pool.ts';

let server: Server;
let base = '';

type TestElement = {
  x: number;
  version: number;
  versionNonce: number;
  customData?: { imageId?: string; kind?: string };
  [key: string]: unknown;
};

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

  async request(method: string, path: string, json?: unknown) {
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
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }

  get(path: string) {
    return this.request('GET', path);
  }
  post(path: string, json?: unknown) {
    return this.request('POST', path, json);
  }
}

function asId(value: unknown): { id: string } {
  return value as { id: string };
}

async function signUp(email: string, name: string): Promise<Session> {
  const session = new Session();
  const result = await session.post('/api/auth/sign-up/email', {
    email,
    password: 'password1234',
    name,
  });
  if (result.status !== 200)
    throw new Error(`sign-up failed: ${result.status}`);
  return session;
}

async function connectPeer(session: Session, sheetId: string) {
  const socket = io(base, {
    autoConnect: false,
    extraHeaders: { cookie: session.cookie },
  });
  const joined = new Promise<{ elements: unknown[] }>((resolve, reject) => {
    socket.once('joined', resolve);
    socket.once('join-denied', reject);
    socket.once('connect_error', reject);
  });
  socket.connect();
  socket.once('connect', () => socket.emit('join', { sheetId }));
  return { socket, joined: await joined };
}

function waitForScene(
  socket: Socket,
): Promise<{ elements: unknown[]; from: string }> {
  return new Promise((resolve) => socket.once('scene', resolve));
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('live Add to sheet', () => {
  test('broadcasts to joined peers and survives a stale debounced edit and rejoin', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const owner = await signUp(
      `sheet-live-owner-${suffix}@example.test`,
      'Owner',
    );
    const group = asId(
      (await owner.post('/groups', { name: `Live ${suffix}` })).json,
    );
    const board = asId(
      (
        await owner.post(`/groups/${group.id}/boards`, {
          name: 'Board',
          open: true,
        })
      ).json,
    );

    const invitedEmail = `sheet-live-member-${suffix}@example.test`;
    const invitation = await owner.post(`/groups/${group.id}/invite`, {
      email: invitedEmail,
    });
    const member = await signUp(invitedEmail, 'Member');
    const accepted = await member.post(
      `/invitations/${(invitation.json as { invitationId: string }).invitationId}/accept`,
    );
    expect(accepted.status).toBe(200);

    const imageRows = await pool.query(
      `INSERT INTO images (board_id, slot, sha256, name, width, height, uploaded_by)
       VALUES ($1,0,$2,'existing',200,100,'tester'), ($1,1,$3,'added',200,100,'tester')
       RETURNING id, slot`,
      [board.id, `sheet-live-a-${suffix}`, `sheet-live-b-${suffix}`],
    );
    const existingImage = imageRows.rows.find((row) => row.slot === 0)
      .id as string;
    const addedImage = imageRows.rows.find((row) => row.slot === 1)
      .id as string;
    const sheet = asId(
      (
        await owner.post(`/boards/${board.id}/sheets`, {
          name: 'Live sheet',
          imageIds: [existingImage],
        })
      ).json,
    );

    let ownerPeer: Awaited<ReturnType<typeof connectPeer>> | undefined;
    let memberPeer: Awaited<ReturnType<typeof connectPeer>> | undefined;
    let rejoined: Awaited<ReturnType<typeof connectPeer>> | undefined;
    try {
      [ownerPeer, memberPeer] = await Promise.all([
        connectPeer(owner, sheet.id),
        connectPeer(member, sheet.id),
      ]);
      const ownerScene = waitForScene(ownerPeer.socket);
      const memberScene = waitForScene(memberPeer.socket);
      const added = await owner.post(
        `/boards/${board.id}/sheets/${sheet.id}/images`,
        {
          imageIds: [addedImage],
        },
      );
      expect(added.status).toBe(200);
      expect((added.json as { added: string[] }).added).toEqual([addedImage]);

      const [ownerBroadcast, memberBroadcast] = await Promise.all([
        ownerScene,
        memberScene,
      ]);
      for (const payload of [ownerBroadcast, memberBroadcast]) {
        expect(
          (payload.elements as TestElement[]).some(
            (el) => el.customData?.imageId === addedImage,
          ),
        ).toBe(true);
        expect(payload.from).toBeTruthy();
      }

      // Model a client that has not processed the HTTP-driven scene before
      // its queued full-scene edit reaches the server. Version merge must keep
      // the new image while accepting this independent position edit.
      const oldScene = ownerPeer.joined.elements as TestElement[];
      const editedScene = oldScene.map((element) =>
        element.customData?.imageId === existingImage
          ? {
              ...element,
              x: element.x + 75,
              version: element.version + 1,
              versionNonce: element.versionNonce + 1,
            }
          : element,
      );
      ownerPeer.socket.emit('scene', { elements: editedScene });

      let stored: TestElement[] = [];
      const deadline = Date.now() + 7000;
      while (Date.now() < deadline) {
        const result = await owner.get(`/sheets/${sheet.id}/elements`);
        stored = (result.json as { elements: TestElement[] }).elements;
        const edited = stored.find(
          (el) => el.customData?.imageId === existingImage,
        );
        if (
          edited?.version === 2 &&
          stored.some((el) => el.customData?.imageId === addedImage)
        )
          break;
        await delay(100);
      }
      expect(stored.some((el) => el.customData?.imageId === addedImage)).toBe(
        true,
      );
      expect(
        stored.find((el) => el.customData?.imageId === existingImage)?.x,
      ).toBe(
        (oldScene.find((el) => el.customData?.imageId === existingImage)?.x ??
          0) + 75,
      );

      rejoined = await connectPeer(member, sheet.id);
      const rejoinedElements = rejoined.joined.elements as TestElement[];
      expect(
        rejoinedElements.some((el) => el.customData?.imageId === addedImage),
      ).toBe(true);
      expect(
        rejoinedElements.find((el) => el.customData?.imageId === existingImage)
          ?.x,
      ).toBe(
        (oldScene.find((el) => el.customData?.imageId === existingImage)?.x ??
          0) + 75,
      );
    } finally {
      ownerPeer?.socket.disconnect();
      memberPeer?.socket.disconnect();
      rejoined?.socket.disconnect();
    }
  }, 15_000);
});
