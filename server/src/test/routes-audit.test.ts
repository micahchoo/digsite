import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'node:http';
// Phase 5 section 1 (docs/phases/5-hardening.md "Access audit"): the seam
// linter (`access-one-function-per-intent.md`) proves no file outside
// access/ reads membership; it does not prove every ROUTE calls an intent.
// This is the other half: every registered route (`Router#routes()`,
// http.ts) must appear in EXPECTATIONS below, or the test fails with the
// route's name — so a new route with neither an entry here nor a `public`
// marking fails the build, per the phase doc's own words. Each entry then
// drives two calls against a real in-process server (createHttpServer,
// same pattern as access.test.ts): unauthenticated (expect 401, except the
// public list) and as `outsider` — a real user in a real, unrelated group
// — against a fixture group ("Lab")'s own objects (expect 403, except a
// short, individually-commented list of routes that are deliberately
// gated by something other than our access/index.ts intents).
import type { AddressInfo } from 'node:net';
import { createCanvas } from '@napi-rs/canvas';
import { buildRouter, createHttpServer } from '../app.ts';
import { pool } from '../db/pool.ts';
import { drain } from '../worker/index.ts';

let server: Server;
let base = '';

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
  put(path: string, json?: unknown) {
    return this.raw('PUT', path, { json });
  }
  patch(path: string, json?: unknown) {
    return this.raw('PATCH', path, { json });
  }
  del(path: string, json?: unknown) {
    return this.raw('DELETE', path, { json });
  }
  postForm(path: string, form: FormData) {
    return this.raw('POST', path, { form });
  }
}

function onePixelPng(): Buffer {
  const canvas = createCanvas(4, 4);
  canvas.getContext('2d').fillRect(0, 0, 4, 4);
  return canvas.encodeSync('png');
}

// Never called unauthenticated in this file — anonymousCall (below) never
// carries a cookie. A route's UNAUTHENTICATED status is checked with no
// session at all, so no Session instance is needed for it.
async function anonymousCall(
  method: string,
  path: string,
): Promise<{ status: number }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Origin: base },
    body: method === 'GET' || method === 'DELETE' ? undefined : '{}',
  });
  return { status: res.status };
}

type Expectation = {
  // A concrete path, params already substituted — built once the fixture
  // exists (see `fixture` below), so every entry is a function of it.
  path: (fx: Fixture) => string;
  method: string;
  // 401 check: 'public' skips it (the route works, or answers something
  // else entirely, with no session — GET /metrics's own token check, for
  // instance). Every other route must 401 with no cookie at all.
  public?: true;
  // 403 check against `outsider` (a real user, real session, member of a
  // DIFFERENT group) hitting Lab's own objects. A number is the exact
  // expected status; a predicate is for "some 4xx, but not literally our
  // 403" (the plugin's own refusal, translated by the route rather than
  // by an access/index.ts intent); 'skip' is for a route with no Lab
  // object in its path at all (a self-service action, or a route that is
  // deliberately public/global) — every 'skip' and every predicate is
  // commented with why, per docs/phases/5-hardening.md section 1's "say
  // which" for anything a grep can't express cleanly.
  outsider: number | ((status: number) => boolean) | 'skip';
};

type Fixture = {
  labId: string;
  bOpenId: string;
  bPrivateId: string;
  sheetId: string;
  imageId: string;
  memberUserId: string;
  invitationId: string; // a still-pending Lab invitation, unaccepted
  jobId: string;
};

const EXPECTATIONS: Record<string, Expectation> = {
  'GET /healthz': {
    method: 'GET',
    path: () => '/healthz',
    public: true,
    outsider: 'skip',
  },
  'GET /readyz': {
    method: 'GET',
    path: () => '/readyz',
    public: true,
    outsider: 'skip',
  },

  'GET /metrics': {
    // No session concept at all — gated by METRICS_TOKEN (metrics.ts), not
    // a cookie. 404 with no token configured in this test run either way,
    // for the same-shaped reason as an object the caller may not see:
    // existence isn't advertised.
    method: 'GET',
    path: () => '/metrics',
    public: true,
    outsider: 'skip',
  },

  'GET /_access/:intent/:objectId': {
    // Test/measurement route (app.ts's own comment): catches AccessDenied
    // and answers 200 {allowed:false,...} on purpose, never 403 — it IS
    // the thing under test elsewhere (access.test.ts), not a product
    // route this audit should hold to the product's own shape.
    method: 'GET',
    path: (fx) => `/_access/boardForViewing/${fx.bPrivateId}`,
    outsider: 'skip',
  },

  'POST /groups': {
    // No group in the path — creating a NEW group is every signed-in
    // user's own action, not access to Lab's.
    method: 'POST',
    path: () => '/groups',
    outsider: 'skip',
  },
  'GET /groups': {
    method: 'GET',
    path: () => '/groups',
    outsider: 'skip', // own list, not Lab's — see POST /groups above
  },
  'GET /groups/:id/members': {
    method: 'GET',
    path: (fx) => `/groups/${fx.labId}/members`,
    outsider: 403,
  },
  'POST /groups/:id/invite': {
    method: 'POST',
    path: (fx) => `/groups/${fx.labId}/invite`,
    outsider: 403,
  },
  'GET /invitations/:id': {
    // Public by design (docs/phases/3-groups.md section 1: the join
    // preview before signing in) — this IS the "listed as public" case
    // the phase-5 doc names explicitly.
    method: 'GET',
    path: (fx) => `/invitations/${fx.invitationId}`,
    public: true,
    outsider: 'skip',
  },
  'GET /groups/:id/invitations': {
    method: 'GET',
    path: (fx) => `/groups/${fx.labId}/invitations`,
    outsider: 403,
  },
  'DELETE /invitations/:id': {
    method: 'DELETE',
    path: (fx) => `/invitations/${fx.invitationId}`,
    outsider: 403, // the invitation IS found (its orgId is read first); groupForInviting(outsider, labId) then denies
  },
  'POST /invitations/:id/accept': {
    // Gated by the PLUGIN's own recipient-email check
    // (YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION), not an
    // access/index.ts intent — groups/routes.ts's own comment on this
    // route names exactly this. `outsider`'s email never matches the
    // invitation's, so the plugin refuses with its own 4xx, not our 403.
    method: 'POST',
    path: (fx) => `/invitations/${fx.invitationId}/accept`,
    outsider: (status) => status >= 400 && status < 500,
  },
  'POST /groups/:id/leave': {
    // Self-service, and gated by the plugin's own membership check
    // (leaveOrganization refuses a non-member with its own error,
    // translated by authApiErrorResponse) — outsider isn't in Lab at all,
    // so this is the plugin's refusal, not ours.
    method: 'POST',
    path: (fx) => `/groups/${fx.labId}/leave`,
    outsider: (status) => status >= 400 && status < 500,
  },
  'PATCH /groups/:id/members/:userId': {
    method: 'PATCH',
    path: (fx) => `/groups/${fx.labId}/members/${fx.memberUserId}`,
    outsider: 403,
  },
  'DELETE /groups/:id/members/:userId': {
    method: 'DELETE',
    path: (fx) => `/groups/${fx.labId}/members/${fx.memberUserId}`,
    outsider: 403,
  },
  'GET /groups/:id/sheets/recent': {
    method: 'GET',
    path: (fx) => `/groups/${fx.labId}/sheets/recent`,
    outsider: 403,
  },
  'GET /groups/:id/sheets': {
    method: 'GET',
    path: (fx) => `/groups/${fx.labId}/sheets`,
    outsider: 403,
  },
  'GET /groups/:id/activity': {
    method: 'GET',
    path: (fx) => `/groups/${fx.labId}/activity`,
    outsider: 403,
  },
  'GET /groups/:id/stats': {
    method: 'GET',
    path: (fx) => `/groups/${fx.labId}/stats`,
    outsider: 403,
  },

  'GET /groups/:id/boards': {
    method: 'GET',
    path: (fx) => `/groups/${fx.labId}/boards`,
    outsider: 403,
  },
  'POST /groups/:id/boards': {
    method: 'POST',
    path: (fx) => `/groups/${fx.labId}/boards`,
    outsider: 403,
  },
  'GET /boards/:id': {
    method: 'GET',
    path: (fx) => `/boards/${fx.bOpenId}`,
    outsider: 403,
  },
  'PATCH /boards/:id': {
    method: 'PATCH',
    path: (fx) => `/boards/${fx.bOpenId}`,
    outsider: 403,
  },
  'DELETE /boards/:id': {
    method: 'DELETE',
    path: (fx) => `/boards/${fx.bOpenId}`,
    outsider: 403,
  },
  'GET /boards/:id/footprint': {
    method: 'GET',
    path: (fx) => `/boards/${fx.bOpenId}/footprint`,
    outsider: 403,
  },
  'GET /boards/:id/allowlist': {
    method: 'GET',
    path: (fx) => `/boards/${fx.bPrivateId}/allowlist`,
    outsider: 403,
  },
  'POST /boards/:id/allowlist': {
    method: 'POST',
    path: (fx) => `/boards/${fx.bPrivateId}/allowlist`,
    outsider: 403,
  },
  'DELETE /boards/:id/allowlist/:userId': {
    method: 'DELETE',
    path: (fx) => `/boards/${fx.bPrivateId}/allowlist/${fx.memberUserId}`,
    outsider: 403,
  },
  'POST /boards/:id/images': {
    method: 'POST',
    path: (fx) => `/boards/${fx.bPrivateId}/images`,
    outsider: 403,
  },
  'GET /boards/:id/images': {
    method: 'GET',
    path: (fx) => `/boards/${fx.bPrivateId}/images`,
    outsider: 403,
  },
  'GET /boards/:id/relations': {
    method: 'GET',
    path: (fx) => `/boards/${fx.bPrivateId}/relations`,
    outsider: 403,
  },
  'GET /images/:id': {
    method: 'GET',
    path: (fx) => `/images/${fx.imageId}`,
    outsider: 403,
  },
  'GET /images/:id/original': {
    method: 'GET',
    path: (fx) => `/images/${fx.imageId}/original`,
    outsider: 403,
  },
  'GET /images/:id/preview': {
    method: 'GET',
    path: (fx) => `/images/${fx.imageId}/preview`,
    outsider: 403,
  },
  'PATCH /images/:id': {
    method: 'PATCH',
    path: (fx) => `/images/${fx.imageId}`,
    outsider: 403,
  },
  'DELETE /images/:id': {
    method: 'DELETE',
    path: (fx) => `/images/${fx.imageId}`,
    outsider: 403,
  },
  'GET /boards/:id/tiles/:sortId/:z/:x/:yfile': {
    method: 'GET',
    path: (fx) => `/boards/${fx.bPrivateId}/tiles/uploaded_at.desc/0/0/0.png`,
    outsider: 403,
  },
  'GET /boards/:id/sections': {
    method: 'GET',
    path: (fx) => `/boards/${fx.bPrivateId}/sections`,
    outsider: 403,
  },
  'POST /boards/:id/sort/:sortId/rebuild': {
    method: 'POST',
    path: (fx) => `/boards/${fx.bPrivateId}/sort/uploaded_at.desc/rebuild`,
    outsider: 403,
  },
  'GET /boards/:id/jobs': {
    method: 'GET',
    path: (fx) => `/boards/${fx.bPrivateId}/jobs`,
    outsider: 403,
  },
  'POST /jobs/:id/retry': {
    method: 'POST',
    path: (fx) => `/jobs/${fx.jobId}/retry`,
    outsider: 403,
  },
  'GET /boards/:id/selection': {
    method: 'GET',
    path: (fx) => `/boards/${fx.bPrivateId}/selection`,
    outsider: 403,
  },
  'PUT /boards/:id/selection': {
    method: 'PUT',
    path: (fx) => `/boards/${fx.bPrivateId}/selection`,
    outsider: 403,
  },
  'POST /boards/:id/selection/range': {
    method: 'POST',
    path: (fx) => `/boards/${fx.bPrivateId}/selection/range`,
    outsider: 403,
  },
  'GET /boards/:id/find': {
    method: 'GET',
    path: (fx) => `/boards/${fx.bPrivateId}/find`,
    outsider: 403,
  },

  'GET /boards/:id/sheets': {
    method: 'GET',
    path: (fx) => `/boards/${fx.bPrivateId}/sheets`,
    outsider: 403,
  },
  'GET /boards/:id/neighbourhood': {
    method: 'GET',
    path: (fx) =>
      `/boards/${fx.bPrivateId}/neighbourhood?from=${fx.imageId}&hops=1`,
    outsider: 403,
  },
  'POST /boards/:id/sheets': {
    method: 'POST',
    path: (fx) => `/boards/${fx.bPrivateId}/sheets`,
    outsider: 403,
  },
  'GET /sheets/:id': {
    method: 'GET',
    path: (fx) => `/sheets/${fx.sheetId}`,
    outsider: 403,
  },
  'PATCH /sheets/:id': {
    method: 'PATCH',
    path: (fx) => `/sheets/${fx.sheetId}`,
    outsider: 403,
  },
  'POST /sheets/:id/seen': {
    method: 'POST',
    path: (fx) => `/sheets/${fx.sheetId}/seen`,
    outsider: 403,
  },
  'POST /sheets/:id/archive': {
    method: 'POST',
    path: (fx) => `/sheets/${fx.sheetId}/archive`,
    outsider: 403,
  },
  'POST /sheets/:id/unarchive': {
    method: 'POST',
    path: (fx) => `/sheets/${fx.sheetId}/unarchive`,
    outsider: 403,
  },
  'POST /boards/:id/sheets/:sheetId/images': {
    method: 'POST',
    path: (fx) => `/boards/${fx.bPrivateId}/sheets/${fx.sheetId}/images`,
    outsider: 403,
  },
  'GET /sheets/:id/footprint': {
    method: 'GET',
    path: (fx) => `/sheets/${fx.sheetId}/footprint`,
    outsider: 403,
  },
  'DELETE /sheets/:id': {
    method: 'DELETE',
    path: (fx) => `/sheets/${fx.sheetId}`,
    outsider: 403,
  },
  'GET /sheets/:id/elements': {
    method: 'GET',
    path: (fx) => `/sheets/${fx.sheetId}/elements`,
    outsider: 403,
  },
  'GET /sheets/:id/foreign': {
    method: 'GET',
    path: (fx) => `/sheets/${fx.sheetId}/foreign`,
    outsider: 403,
  },
  'GET /sheets/:id/rows': {
    method: 'GET',
    path: (fx) => `/sheets/${fx.sheetId}/rows`,
    outsider: 403,
  },
  'GET /stats': {
    // Global, non-object counters (room.ts's roomStats) — requireAuth
    // only, by design; nothing here is per-group or per-board.
    method: 'GET',
    path: () => '/stats',
    outsider: 'skip',
  },
};

describe('routes audit', () => {
  let fixture: Fixture;
  let outsider: Session;

  beforeAll(async () => {
    server = createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address() as AddressInfo;
    base = `http://127.0.0.1:${addr.port}`;

    const ts = Date.now();
    const owner = new Session();
    await owner.post('/api/auth/sign-up/email', {
      email: `audit-owner-${ts}@example.test`,
      password: 'password1234',
      name: 'owner',
    });
    const lab = await owner.post('/groups', { name: `Audit-Lab-${ts}` });
    const labId = withId(lab.json).id;

    const member = new Session();
    const invited = await member.post('/api/auth/sign-up/email', {
      email: `audit-member-${ts}@example.test`,
      password: 'password1234',
      name: 'member',
    });
    const memberUserId = (invited.json as { user: { id: string } }).user.id;
    const invite = await owner.post(`/groups/${labId}/invite`, {
      email: `audit-member-${ts}@example.test`,
    });
    const invitation = invite.json as { invitationId: string };
    await member.post(`/invitations/${invitation.invitationId}/accept`);

    const bOpen = await member.post(`/groups/${labId}/boards`, {
      name: 'Open',
      open: true,
    });
    const bOpenId = withId(bOpen.json).id;
    const bPrivate = await owner.post(`/groups/${labId}/boards`, {
      name: 'Private',
      open: false,
    });
    const bPrivateId = withId(bPrivate.json).id;

    const form = new FormData();
    form.append(
      'files',
      new Blob([onePixelPng()], { type: 'image/png' }),
      'dot.png',
    );
    const upload = await owner.postForm(
      `/boards/${bPrivateId}/images?wait=0`,
      form,
    );
    const imageId = (upload.json as { id: string }[])[0]?.id;
    if (!imageId) throw new Error('fixture upload returned no image');
    await drain();

    const sheet = await owner.post(`/boards/${bPrivateId}/sheets`, {
      name: 'Sheet',
      imageIds: [imageId],
    });
    const sheetId = withId(sheet.json).id;

    // A still-pending, unaccepted invitation — GET/DELETE /invitations/:id
    // and POST /invitations/:id/accept all want one that exists and
    // hasn't already been consumed by the member invite above.
    const spareInvite = await owner.post(`/groups/${labId}/invite`, {
      email: `audit-spare-${ts}@example.test`,
    });
    const invitationId = (spareInvite.json as { invitationId: string })
      .invitationId;

    const { rows: jobRows } = await pool.query(
      `SELECT id FROM jobs WHERE payload->>'boardId' = $1 LIMIT 1`,
      [bPrivateId],
    );
    const jobId = jobRows[0]?.id;
    if (jobId === undefined) throw new Error('fixture upload enqueued no job');

    fixture = {
      labId,
      bOpenId,
      bPrivateId,
      sheetId,
      imageId,
      memberUserId,
      invitationId,
      jobId: String(jobId),
    };

    outsider = new Session();
    await outsider.post('/api/auth/sign-up/email', {
      email: `audit-outsider-${ts}@example.test`,
      password: 'password1234',
      name: 'outsider',
    });
    await outsider.post('/groups', { name: `Audit-Other-${ts}` }); // a group of their own, unrelated to Lab
  });

  afterAll(
    () =>
      new Promise<void>((resolve) => {
        // fetch's keep-alive sockets otherwise hold `close()` open past
        // the default 5s hook timeout — this file makes ~150 requests
        // (47 routes x up to 3 checks), same race sheets-routes.test.ts
        // hit first; see that file's own comment on this line.
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );

  test('every registered route has audit coverage', () => {
    const router = buildRouter();
    const registered = router.routes().map((r) => `${r.method} ${r.pattern}`);
    const missing = registered.filter((key) => !(key in EXPECTATIONS));
    if (missing.length > 0) {
      throw new Error(
        `route(s) registered with no audit coverage — add an EXPECTATIONS entry (or a documented exception) for:\n${missing.join('\n')}`,
      );
    }
    // The reverse direction too: a stale entry (a route that was removed
    // or renamed) would otherwise sit here unexercised and drifting.
    const stale = Object.keys(EXPECTATIONS).filter(
      (key) => !registered.includes(key),
    );
    if (stale.length > 0) {
      throw new Error(
        `EXPECTATIONS entry for a route that no longer exists:\n${stale.join('\n')}`,
      );
    }
    expect(registered.length).toBeGreaterThan(0);
  });

  test('every non-public route 401s with no session', async () => {
    const failures: string[] = [];
    for (const [name, exp] of Object.entries(EXPECTATIONS)) {
      if (exp.public) continue;
      const { status } = await anonymousCall(exp.method, exp.path(fixture));
      if (status !== 401) failures.push(`${name}: expected 401, got ${status}`);
    }
    if (failures.length > 0) throw new Error(failures.join('\n'));
  });

  test('every public route works with no session (not 401)', async () => {
    const failures: string[] = [];
    for (const [name, exp] of Object.entries(EXPECTATIONS)) {
      if (!exp.public) continue;
      const { status } = await anonymousCall(exp.method, exp.path(fixture));
      if (status === 401)
        failures.push(`${name}: got 401, expected a public route not to`);
    }
    if (failures.length > 0) throw new Error(failures.join('\n'));
  });

  test('outsider is refused on every Lab-scoped route', async () => {
    const failures: string[] = [];
    for (const [name, exp] of Object.entries(EXPECTATIONS)) {
      if (exp.outsider === 'skip') continue;
      const path = exp.path(fixture);
      const res =
        exp.method === 'GET'
          ? await outsider.get(path)
          : exp.method === 'POST'
            ? await outsider.post(path, {})
            : exp.method === 'PUT'
              ? await outsider.put(path, {})
              : exp.method === 'PATCH'
                ? await outsider.patch(path, {})
                : await outsider.del(path);
      const ok =
        typeof exp.outsider === 'number'
          ? res.status === exp.outsider
          : exp.outsider(res.status);
      if (!ok) {
        failures.push(
          `${name}: outsider got ${res.status} ${JSON.stringify(res.json)}`,
        );
      }
    }
    if (failures.length > 0) throw new Error(failures.join('\n'));
  });

  test('activity limit rejects non-integers before reaching SQL', async () => {
    const res = await outsider.get(
      `/groups/${fixture.labId}/activity?limit=abc`,
    );
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: 'limit must be a positive integer' });
  });
});
