import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// docs/phases/3-groups.md's own walk, as an in-process integration test
// (same createHttpServer()-on-an-ephemeral-port approach as access.test.ts
// and delete.test.ts): create group -> invite by link -> accept -> private
// board -> allowlist change -> member leaves -> board with claims deleted
// -> sheet deleted. This is the fast, always-run bun test; the slower,
// real-HTTP walk against a seeded, separately-started server is
// e2e/src/groups-life.ts (per this task's brief) — the two overlap on
// purpose, one in-process and disposable, one against the real dev stack.
import { existsSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { createHttpServer } from '../app.ts';
import { pool } from '../db/pool.ts';
import { env } from '../env.ts';
import { drain } from '../worker/index.ts';

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
  patch(path: string, json?: unknown) {
    return this.raw('PATCH', path, { json });
  }
  del(path: string) {
    return this.raw('DELETE', path);
  }
  postForm(path: string, form: FormData) {
    return this.raw('POST', path, { form });
  }
}

function withId(json: unknown): { id: string } {
  return json as { id: string };
}

type SignedIn = { session: Session; userId: string };

async function signUpOrIn(email: string, name: string): Promise<SignedIn> {
  const s = new Session();
  const up = await s.post('/api/auth/sign-up/email', {
    email,
    password: 'password1234',
    name,
  });
  if (up.status === 200) {
    const body = up.json as { user: { id: string } };
    return { session: s, userId: body.user.id };
  }
  const inn = await s.post('/api/auth/sign-in/email', {
    email,
    password: 'password1234',
  });
  if (inn.status !== 200) {
    throw new Error(`sign-in failed ${email}: ${inn.status}`);
  }
  const body = inn.json as { user: { id: string } };
  return { session: s, userId: body.user.id };
}

function onePixelPng(): Buffer {
  const canvas = createCanvas(4, 4);
  canvas.getContext('2d').fillRect(0, 0, 4, 4);
  return canvas.encodeSync('png');
}

describe('groups-life', () => {
  test('create -> invite by link -> accept -> private board -> allowlist change -> leave -> delete board -> delete sheet', async () => {
    const ts = Date.now();

    // -- create -----------------------------------------------------------
    const owner = await signUpOrIn(`life-owner-${ts}@example.test`, 'owner');
    const created = await owner.session.post('/groups', {
      name: `Life-${ts}`,
    });
    expect(created.status).toBe(200);
    const groupId = withId(created.json).id;

    // -- invite by link -----------------------------------------------------
    const memberEmail = `life-member-${ts}@example.test`;
    const invite = await owner.session.post(`/groups/${groupId}/invite`, {
      email: memberEmail,
    });
    expect(invite.status).toBe(200);
    const inviteBody = invite.json as { invitationId: string; url: string };
    expect(inviteBody.url).toBe(
      `${env.WEB_ORIGIN}/join/${inviteBody.invitationId}`,
    );

    const pending = await owner.session.get(`/groups/${groupId}/invitations`);
    expect(pending.status).toBe(200);
    const pendingBody = pending.json as { id: string; email: string | null }[];
    expect(pendingBody.some((i) => i.id === inviteBody.invitationId)).toBe(
      true,
    );

    // GET /invitations/:id is public — no session.
    const preview = await fetch(
      `${base}/invitations/${inviteBody.invitationId}`,
    );
    expect(preview.status).toBe(200);
    const previewBody = (await preview.json()) as {
      groupName: string;
      inviterName: string;
      open: boolean;
    };
    expect(previewBody.groupName).toBe(`Life-${ts}`);
    expect(previewBody.inviterName).toBe('owner');
    expect(previewBody.open).toBe(true);

    // -- accept ---------------------------------------------------------
    const member = await signUpOrIn(memberEmail, 'member');
    const accept = await member.session.post(
      `/invitations/${inviteBody.invitationId}/accept`,
    );
    expect(accept.status).toBe(200);
    expect((accept.json as { groupId: string }).groupId).toBe(groupId);

    // Accepting again (or accepting a revoked one) is the one message,
    // never a second distinct one.
    const replay = await member.session.post(
      `/invitations/${inviteBody.invitationId}/accept`,
    );
    expect(replay.status).toBe(400);
    expect(replay.json).toEqual({
      reason: 'This invitation is no longer open.',
    });

    const members = await owner.session.get(`/groups/${groupId}/members`);
    expect(members.status).toBe(200);
    const memberRows = members.json as { userId: string; role: string }[];
    expect(memberRows.find((m) => m.userId === member.userId)?.role).toBe(
      'member',
    );

    // -- private board, allowlist change -----------------------------------
    const board = await owner.session.post(`/groups/${groupId}/boards`, {
      name: 'Private',
      open: false,
    });
    expect(board.status).toBe(200);
    const boardId = withId(board.json).id;

    // owner is the creator, so is on the allowlist from creation — but is
    // NOT the group's owner-or-admin gate here, boardForManagingAllowlist
    // passes as creator.
    const before = await owner.session.get(`/boards/${boardId}/allowlist`);
    expect(before.status).toBe(200);
    const beforeMembers = (
      before.json as { groupId: string; members: { userId: string }[] }
    ).members;
    expect(beforeMembers.map((m) => m.userId)).toEqual([owner.userId]);

    // member cannot see the private board yet.
    const deniedView = await member.session.get(`/boards/${boardId}`);
    expect(deniedView.status).toBe(403);

    const added = await owner.session.post(`/boards/${boardId}/allowlist`, {
      userId: member.userId,
    });
    expect(added.status).toBe(200);

    const afterAdd = await owner.session.get(`/boards/${boardId}/allowlist`);
    const afterAddMembers = (afterAdd.json as { members: { userId: string }[] })
      .members;
    expect(afterAddMembers.map((m) => m.userId).sort()).toEqual(
      [owner.userId, member.userId].sort(),
    );

    // member can see it now.
    const nowVisible = await member.session.get(`/boards/${boardId}`);
    expect(nowVisible.status).toBe(200);

    // Upload an image and create a sheet with a claim, so the eventual
    // board delete has something to account for.
    const form = new FormData();
    form.append(
      'files',
      new Blob([onePixelPng()], { type: 'image/png' }),
      'dot.png',
    );
    const upload = await owner.session.postForm(
      `/boards/${boardId}/images?wait=0`,
      form,
    );
    expect(upload.status).toBe(202);
    const uploadedImages = upload.json as { id: string }[];
    const imageId = uploadedImages[0]?.id;
    if (!imageId) throw new Error('upload returned no image');
    await drain();

    const sheet = await owner.session.post(`/boards/${boardId}/sheets`, {
      name: 'Claims',
      imageIds: [imageId],
    });
    expect(sheet.status).toBe(200);
    const sheetId = withId(sheet.json).id;

    // -- member leaves the group ------------------------------------------
    // Leaving cleans up the allowlist team row too (auth.ts's own plugin
    // behaviour, ../../../.claude/rules/access-one-function-per-intent.md
    // "what the plugin does").
    const left = await member.session.post(`/groups/${groupId}/leave`);
    expect(left.status).toBe(200);

    const afterLeave = await owner.session.get(`/boards/${boardId}/allowlist`);
    const afterLeaveMembers = (
      afterLeave.json as { members: { userId: string }[] }
    ).members;
    expect(afterLeaveMembers.map((m) => m.userId)).toEqual([owner.userId]);

    // The sole owner cannot leave.
    const ownerLeave = await owner.session.post(`/groups/${groupId}/leave`);
    expect(ownerLeave.status).toBe(400);

    // -- delete the board with claims on it ---------------------------------
    const footprint = await owner.session.get(`/boards/${boardId}/footprint`);
    expect(footprint.status).toBe(200);
    expect(footprint.json).toEqual({
      images: 1,
      sheets: 1,
      regions: 0,
      edges: 0,
    });

    const boardDir = join(env.DATA_DIR, 'boards', boardId);
    expect(existsSync(boardDir)).toBe(true);

    const deletedBoard = await owner.session.del(`/boards/${boardId}`);
    expect(deletedBoard.status).toBe(200);
    expect(existsSync(boardDir)).toBe(false);

    const { rows: boardRows } = await pool.query(
      'SELECT 1 FROM boards WHERE id = $1',
      [boardId],
    );
    expect(boardRows.length).toBe(0);

    // -- delete a sheet on a second, still-live board ------------------------
    const board2 = await owner.session.post(`/groups/${groupId}/boards`, {
      name: 'Open',
      open: true,
    });
    expect(board2.status).toBe(200);
    const board2Id = withId(board2.json).id;
    const { rows: imgRows } = await pool.query(
      `INSERT INTO images (board_id, slot, sha256, name, width, height, uploaded_by)
       VALUES ($1,0,$2,'a',100,100,'tester') RETURNING id`,
      [board2Id, `sha-life-${ts}`],
    );
    const img2 = imgRows[0].id as string;
    const sheet2 = await owner.session.post(`/boards/${board2Id}/sheets`, {
      name: 'S2',
      imageIds: [img2],
    });
    const sheet2Id = withId(sheet2.json).id;

    const deletedSheet = await owner.session.del(`/sheets/${sheet2Id}`);
    expect(deletedSheet.status).toBe(200);
    const { rows: sheetRows } = await pool.query(
      'SELECT 1 FROM sheets WHERE id = $1',
      [sheet2Id],
    );
    expect(sheetRows.length).toBe(0);
  });
});
