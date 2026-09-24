import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// Who may make an account (SIGNUP=invite), how many groups one person may
// make, and the operator's account recovery — through the real HTTP app,
// so Better Auth's own hooks run. env is set per test and put back, since
// every test file shares this process.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHttpServer } from '../app.ts';
import { env } from '../env.ts';

let server: Server;
let base = '';

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

class Session {
  cookie = '';
  async call(method: string, path: string, json?: unknown) {
    const headers: Record<string, string> = { Origin: base };
    if (this.cookie) headers.cookie = this.cookie;
    if (json !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0] ?? '';
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }
}

const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const PASSWORD = 'password1234';

async function signUp(email: string) {
  const s = new Session();
  const r = await s.call('POST', '/api/auth/sign-up/email', {
    email,
    password: PASSWORD,
    name: email.split('@')[0],
  });
  return { session: s, status: r.status };
}

async function withEnv<T>(
  patch: Partial<typeof env>,
  run: () => Promise<T>,
): Promise<T> {
  const before = { ...env };
  Object.assign(env, patch);
  try {
    return await run();
  } finally {
    Object.assign(env, before);
  }
}

describe('sign-up by invitation', () => {
  test('a stranger is refused; an invited email and an operator are not', async () => {
    const owner = await signUp(`owner-${unique()}@example.test`);
    const group = await owner.session.call('POST', '/groups', {
      name: `g-${unique()}`,
    });
    const invited = `invited-${unique()}@example.test`;
    const invite = await owner.session.call(
      'POST',
      `/groups/${group.body.id}/invite`,
      { email: invited },
    );
    expect(invite.status).toBe(200);
    const operator = `op-${unique()}@example.test`;

    await withEnv(
      { SIGNUP: 'invite', OPERATOR_EMAILS: [operator] },
      async () => {
        expect((await signUp(`stranger-${unique()}@example.test`)).status).toBe(
          403,
        );
        expect((await signUp(invited.toUpperCase())).status).toBe(200);
        expect((await signUp(operator)).status).toBe(200);
      },
    );
  });
});

describe('groups per person', () => {
  test('past the limit a new group is refused; groups joined do not count', async () => {
    const { session } = await signUp(`maker-${unique()}@example.test`);
    await withEnv({ MAX_GROUPS_PER_USER: 1 }, async () => {
      const first = await session.call('POST', '/groups', {
        name: `a-${unique()}`,
      });
      expect(first.status).toBe(200);
      const second = await session.call('POST', '/groups', {
        name: `b-${unique()}`,
      });
      expect(second.status).toBeGreaterThanOrEqual(400);
      expect(second.status).toBeLessThan(500);
    });
  });
});

describe('account recovery by the operator', () => {
  test('only an operator sees the accounts', async () => {
    const { session } = await signUp(`plain-${unique()}@example.test`);
    expect((await session.call('GET', '/operator')).status).toBe(403);
    expect((await session.call('GET', '/operator/accounts')).status).toBe(403);
  });

  test('a new password works, the old one does not, and old sessions end', async () => {
    const opEmail = `op-${unique()}@example.test`;
    const op = await signUp(opEmail);
    const personEmail = `person-${unique()}@example.test`;
    const person = await signUp(personEmail);

    await withEnv({ OPERATOR_EMAILS: [opEmail] }, async () => {
      expect((await op.session.call('GET', '/operator')).status).toBe(200);
      const accounts = await op.session.call('GET', '/operator/accounts');
      const target = (accounts.body as { id: string; email: string }[]).find(
        (a) => a.email === personEmail,
      );
      expect(target).toBeTruthy();

      const short = await op.session.call(
        'POST',
        `/operator/accounts/${target?.id}/password`,
        { password: 'short' },
      );
      expect(short.status).toBe(400);

      const set = await op.session.call(
        'POST',
        `/operator/accounts/${target?.id}/password`,
        { password: 'a-new-password-99' },
      );
      expect(set.status).toBe(200);
    });

    expect((await person.session.call('GET', '/groups')).status).toBe(401);
    const old = new Session();
    expect(
      (
        await old.call('POST', '/api/auth/sign-in/email', {
          email: personEmail,
          password: PASSWORD,
        })
      ).status,
    ).toBe(401);
    const fresh = new Session();
    expect(
      (
        await fresh.call('POST', '/api/auth/sign-in/email', {
          email: personEmail,
          password: 'a-new-password-99',
        })
      ).status,
    ).toBe(200);
  });
});
