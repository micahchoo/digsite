import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'node:http';
// docs/design.md "Tests": the 35-cell matrix from
// ../prototype/groups/CONTRACT.md re-expressed against this fixture: five
// users x seven intents, zero deviations; plus boardsForListing per user.
//
// Fixture setup goes through the real HTTP routes (an in-process server on
// an ephemeral port) — Better Auth's sign-up/invite/accept/team flows are
// awkward to call in-process without real session cookies, and the routes
// are the same code a browser would drive. The 35 assertions themselves
// call the access functions directly, per .claude/rules/
// access-one-function-per-intent.md.
import type { AddressInfo } from 'node:net';
import { createCanvas } from '@napi-rs/canvas';
import {
  AccessDenied,
  boardForCreating,
  boardForManagingAllowlist,
  boardForViewing,
  boardsForListing,
  groupForViewing,
  sheetForEditing,
} from '../access/index.ts';
import { createHttpServer } from '../app.ts';
import { drain } from '../worker/index.ts';

let server: Server;
let base = '';

/** Every 2xx create route here answers `{id: string, ...}` — one cast, not
 * one per call site. */
function withId(json: unknown): { id: string } {
  return json as { id: string };
}

class Session {
  cookie = '';

  private async raw(
    method: string,
    path: string,
    init: { json?: unknown; form?: FormData } = {},
  ): Promise<{ status: number; json: unknown }> {
    const headers: Record<string, string> = { Origin: base };
    if (this.cookie) headers.cookie = this.cookie;
    let body: string | FormData | undefined;
    if (init.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(init.json);
    } else if (init.form !== undefined) {
      body = init.form;
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
  postForm(path: string, form: FormData) {
    return this.raw('POST', path, { form });
  }
}

type SignedIn = { session: Session; userId: string };

async function signUpOrIn(email: string, name: string): Promise<SignedIn> {
  const s = new Session();
  const up = await s.post('/api/auth/sign-up/email', {
    email,
    password: 'password1',
    name,
  });
  if (up.status === 200) {
    const body = up.json as { user: { id: string } };
    return { session: s, userId: body.user.id };
  }
  const inn = await s.post('/api/auth/sign-in/email', {
    email,
    password: 'password1',
  });
  if (inn.status !== 200)
    throw new Error(`sign-in failed ${email}: ${inn.status}`);
  const body = inn.json as { user: { id: string } };
  return { session: s, userId: body.user.id };
}

async function inviteAndAccept(
  inviter: SignedIn,
  orgId: string,
  email: string,
  name: string,
): Promise<SignedIn> {
  const invite = await inviter.session.post(`/groups/${orgId}/invite`, {
    email,
  });
  if (invite.status !== 200) {
    throw new Error(
      `invite ${email} failed: ${invite.status} ${JSON.stringify(invite.json)}`,
    );
  }
  const invited = await signUpOrIn(email, name);
  const invitation = invite.json as { invitationId: string };
  const accept = await invited.session.post(
    `/invitations/${invitation.invitationId}/accept`,
  );
  if (accept.status !== 200) {
    throw new Error(
      `accept ${email} failed: ${accept.status} ${JSON.stringify(accept.json)}`,
    );
  }
  return invited;
}

function onePixelPng(): Buffer {
  const canvas = createCanvas(4, 4);
  canvas.getContext('2d').fillRect(0, 0, 4, 4);
  return canvas.encodeSync('png');
}

async function isAllowed(
  fn: (userId: string, objectId: string) => Promise<unknown>,
  userId: string,
  objectId: string,
): Promise<boolean> {
  try {
    await fn(userId, objectId);
    return true;
  } catch (err) {
    if (err instanceof AccessDenied) return false;
    throw err;
  }
}

describe('access matrix', () => {
  beforeAll(async () => {
    server = createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address() as AddressInfo;
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  test('35 cells (5 users x 7 intents) match the groups prototype contract, plus boardsForListing', async () => {
    const ts = Date.now();

    const owner = await signUpOrIn(`owner-${ts}@example.test`, 'owner');
    const g1 = await owner.session.post('/groups', { name: `Lab-${ts}` });
    expect(g1.status).toBe(200);
    const g1Id = withId(g1.json).id;

    const admin = await inviteAndAccept(
      owner,
      g1Id,
      `admin-${ts}@example.test`,
      'admin',
    );
    const member = await inviteAndAccept(
      owner,
      g1Id,
      `member-${ts}@example.test`,
      'member',
    );
    const listed = await inviteAndAccept(
      owner,
      g1Id,
      `listed-${ts}@example.test`,
      'listed',
    );

    const listMembers = await owner.session.get(
      `/api/auth/organization/list-members?organizationId=${g1Id}`,
    );
    const membersBody = listMembers.json as {
      members: { id: string; userId: string }[];
    };
    const adminRow = membersBody.members.find((m) => m.userId === admin.userId);
    const promote = await owner.session.post(
      '/api/auth/organization/update-member-role',
      {
        memberId: adminRow?.id,
        role: 'admin',
        organizationId: g1Id,
      },
    );
    expect(promote.status).toBe(200);

    const outsider = await signUpOrIn(
      `outsider-${ts}@example.test`,
      'outsider',
    );
    const g2 = await outsider.session.post('/groups', { name: `Other-${ts}` });
    expect(g2.status).toBe(200);

    const bOpen = await member.session.post(`/groups/${g1Id}/boards`, {
      name: 'B-open',
      open: true,
    });
    expect(bOpen.status).toBe(200);
    const bOpenId = withId(bOpen.json).id;

    const bPrivate = await admin.session.post(`/groups/${g1Id}/boards`, {
      name: 'B-private',
      open: false,
    });
    expect(bPrivate.status).toBe(200);
    const bPrivateId = withId(bPrivate.json).id;

    const allow = await admin.session.post(`/boards/${bPrivateId}/allowlist`, {
      userId: listed.userId,
    });
    expect(allow.status).toBe(200);

    const form = new FormData();
    form.append(
      'files',
      new Blob([onePixelPng()], { type: 'image/png' }),
      'dot.png',
    );
    // docs/phases/1-map.md: uploads are now async (202, enqueues a `ladder`
    // job). This test server never calls startWorker(), so ?wait=0 skips
    // the route's own 10s wait and `drain()` runs the job directly —
    // otherwise the sheet-creation step below would see width/height still
    // at their pending placeholder of 0.
    const upload = await admin.session.postForm(
      `/boards/${bPrivateId}/images?wait=0`,
      form,
    );
    expect(upload.status).toBe(202);
    const uploadedImages = upload.json as { id: string }[];
    const bPrivateImageId = uploadedImages[0]?.id;
    if (!bPrivateImageId) throw new Error('upload returned no image');
    await drain();

    const sPrivate = await admin.session.post(`/boards/${bPrivateId}/sheets`, {
      name: 'S-private',
      imageIds: [bPrivateImageId],
    });
    expect(sPrivate.status).toBe(200);
    const sPrivateId = withId(sPrivate.json).id;

    const g2Id = withId(g2.json).id;
    const b2Open = await outsider.session.post(`/groups/${g2Id}/boards`, {
      name: 'B2-open',
      open: true,
    });
    expect(b2Open.status).toBe(200);
    const b2OpenId = withId(b2Open.json).id;

    // The matrix (prototype/groups/CONTRACT.md), same 7 columns, this
    // fixture's object ids.
    const columns: [
      string,
      (u: string, o: string) => Promise<unknown>,
      string,
    ][] = [
      ['groupForViewing(G1)', groupForViewing, g1Id],
      ['boardForViewing(B-open)', boardForViewing, bOpenId],
      ['boardForViewing(B-private)', boardForViewing, bPrivateId],
      [
        'boardForManagingAllowlist(B-private)',
        boardForManagingAllowlist,
        bPrivateId,
      ],
      ['boardForCreating(G1)', boardForCreating, g1Id],
      ['sheetForEditing(S-private)', sheetForEditing, sPrivateId],
      ['boardForViewing(B2-open)', boardForViewing, b2OpenId],
    ];

    const expected: Record<string, boolean[]> = {
      owner: [true, true, false, false, true, false, false],
      admin: [true, true, true, true, true, true, false],
      member: [true, true, false, false, true, false, false],
      listed: [true, true, true, false, true, true, false],
      outsider: [false, false, false, false, false, false, true],
    };
    const users: Record<string, SignedIn> = {
      owner,
      admin,
      member,
      listed,
      outsider,
    };

    for (const [userName, { userId }] of Object.entries(users)) {
      const wants = expected[userName];
      if (!wants) throw new Error(`no expectations for ${userName}`);
      for (const [i, [label, fn, objectId]] of columns.entries()) {
        const got = await isAllowed(fn, userId, objectId);
        const want = wants[i];
        if (got !== want) {
          throw new Error(
            `${userName} / ${label}: expected ${want}, got ${got}`,
          );
        }
      }
    }

    async function boardNames(userId: string): Promise<string[] | 'denied'> {
      try {
        const rows = await boardsForListing(userId, g1Id);
        return rows.map((r) => r.name).sort();
      } catch (err) {
        if (err instanceof AccessDenied) return 'denied';
        throw err;
      }
    }

    expect(await boardNames(owner.userId)).toEqual(['B-open']);
    expect(await boardNames(admin.userId)).toEqual(['B-open', 'B-private']);
    expect(await boardNames(member.userId)).toEqual(['B-open']);
    expect(await boardNames(listed.userId)).toEqual(['B-open', 'B-private']);
    expect(await boardNames(outsider.userId)).toBe('denied');
  });
});
