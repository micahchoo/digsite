import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// docs/ux/audit.md #7 (invites) and docs/phases/6-product.md's 403
// "askName" spec — both fixed inside groups/routes.ts and access/index.ts
// respectively, same in-process integration approach as access.test.ts.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHttpServer } from '../app.ts';

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
    json?: unknown,
  ): Promise<{ status: number; json: unknown }> {
    const headers: Record<string, string> = { Origin: base };
    if (this.cookie) headers.cookie = this.cookie;
    let body: string | undefined;
    if (json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    }
    const res = await fetch(`${base}${path}`, { method, headers, body });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0] ?? '';
    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    return { status: res.status, json: parsed };
  }
  get(path: string) {
    return this.raw('GET', path);
  }
  post(path: string, json?: unknown) {
    return this.raw('POST', path, json);
  }
}

function withId(json: unknown): { id: string } {
  return json as { id: string };
}

async function signUp(email: string, name: string): Promise<Session> {
  const s = new Session();
  await s.post('/api/auth/sign-up/email', {
    email,
    password: 'password1234',
    name,
  });
  return s;
}

describe('invites (docs/ux/audit.md #7)', () => {
  test('empty and malformed email are 400 {reason}; re-invite is idempotent 200', async () => {
    const ts = Date.now();
    const owner = await signUp(`inv-owner-${ts}@example.test`, 'owner');
    const group = await owner.post('/groups', { name: `Inv-${ts}` });
    const groupId = withId(group.json).id;

    const blank = await owner.post(`/groups/${groupId}/invite`, { email: '' });
    expect(blank.status).toBe(400);
    expect((blank.json as { reason: string }).reason).toBeTruthy();

    const malformed = await owner.post(`/groups/${groupId}/invite`, {
      email: 'not-an-email',
    });
    expect(malformed.status).toBe(400);
    expect((malformed.json as { reason: string }).reason).toBeTruthy();

    const target = `invitee-${ts}@example.test`;
    const first = await owner.post(`/groups/${groupId}/invite`, {
      email: target,
    });
    expect(first.status).toBe(200);
    const firstId = (first.json as { invitationId: string }).invitationId;
    expect(firstId).toBeTruthy();

    // Re-inviting the same still-pending address must be idempotent 200,
    // returning the existing invitation — never a 500.
    const again = await owner.post(`/groups/${groupId}/invite`, {
      email: target,
    });
    expect(again.status).toBe(200);
    expect((again.json as { invitationId: string }).invitationId).toBe(firstId);
  });
});

describe('403 bodies name whom to ask (docs/phases/6-product.md)', () => {
  test('a group member denied a private board learns whom to ask; a non-member learns nothing', async () => {
    const ts = Date.now();
    const owner = await signUp(`ask-owner-${ts}@example.test`, 'Asker Owner');
    const group = await owner.post('/groups', { name: `Ask-${ts}` });
    const groupId = withId(group.json).id;

    const board = await owner.post(`/groups/${groupId}/boards`, {
      name: 'Private',
      open: false,
    });
    const boardId = withId(board.json).id;

    // A group member NOT on the private board's allowlist.
    const memberEmail = `ask-member-${ts}@example.test`;
    const invite = await owner.post(`/groups/${groupId}/invite`, {
      email: memberEmail,
    });
    const invitationId = (invite.json as { invitationId: string }).invitationId;
    const member = await signUp(memberEmail, 'Member');
    const accept = await member.post(`/invitations/${invitationId}/accept`);
    expect(accept.status).toBe(200);

    const memberDenied = await member.get(`/boards/${boardId}`);
    expect(memberDenied.status).toBe(403);
    const memberBody = memberDenied.json as {
      reason: string;
      askName?: string;
    };
    expect(memberBody.reason).toBeTruthy();
    expect(memberBody.askName).toBe('Asker Owner');

    // A user with no relationship to this group at all.
    const outsider = await signUp(
      `ask-outsider-${ts}@example.test`,
      'Outsider',
    );
    await outsider.post('/groups', { name: `Other-${ts}` });
    const outsiderDenied = await outsider.get(`/boards/${boardId}`);
    expect(outsiderDenied.status).toBe(403);
    const outsiderBody = outsiderDenied.json as {
      reason: string;
      askName?: string;
    };
    expect(outsiderBody.reason).toBeTruthy();
    expect(outsiderBody.askName).toBeUndefined();
  });
});
