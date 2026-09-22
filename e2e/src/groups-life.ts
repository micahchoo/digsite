// docs/phases/3-groups.md's own walk, through real HTTP against a running
// server (this task's own 8807 instance, after `bun run seed`): create a
// group, invite by link, accept, make a private board, change its
// allowlist, have a member leave, delete a board with claims on it, delete
// a sheet. PASS/FAIL per step, same harness shape as run.ts's `scenario()`
// (session.ts's plain-fetch Session — see its header comment for why not
// Playwright's `request` module).
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';
import { SERVER, Session, WEB, signIn } from './session.ts';

function onePixelPng(): Buffer {
  const canvas = createCanvas(4, 4);
  canvas.getContext('2d').fillRect(0, 0, 4, 4);
  return canvas.encodeSync('png');
}

const HERE = dirname(fileURLToPath(import.meta.url));
// e2e/src -> e2e -> app -> data (env.ts's default DATA_DIR, resolved the
// same way from the repo root). Only used for the one best-effort "no
// files" check below; a differently configured DATA_DIR fails just that
// one step, not the run.
const DATA_DIR = join(HERE, '../../data');

function fail(message: string): never {
  throw new Error(message);
}

function assertStatus(
  res: { status: number },
  want: number,
  label: string,
): void {
  if (res.status !== want) {
    fail(`${label}: status ${res.status}, want ${want}`);
  }
}

type ScenarioResult = {
  n: number;
  label: string;
  pass: boolean;
  detail: string;
};
const results: ScenarioResult[] = [];

async function scenario(
  n: number,
  label: string,
  fn: () => Promise<string>,
): Promise<void> {
  try {
    const detail = await fn();
    console.log(`PASS ${n}. ${label}${detail ? ` — ${detail}` : ''}`);
    results.push({ n, label, pass: true, detail });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`FAIL ${n}. ${label} — ${msg}`);
    results.push({ n, label, pass: false, detail: msg });
  }
}

async function main() {
  console.log(`groups-life: server=${SERVER} web=${WEB}`);

  const ts = Date.now();
  const owner = await signIn('owner@example.test', 'password1');

  let groupId = '';
  let invitationId = '';
  let inviteUrl = '';
  let member: Session | null = null;
  let boardId = '';
  let sheetId = '';

  await scenario(1, 'create a group', async () => {
    const res = await owner.post<{ id: string }>('/groups', {
      name: `e2e-life-${ts}`,
    });
    assertStatus(res, 200, 'create group');
    if (!res.json.id) fail('create group response had no id');
    groupId = res.json.id;
    return groupId;
  });

  await scenario(2, 'invite by link', async () => {
    const email = `e2e-life-member-${ts}@example.test`;
    const res = await owner.post<{ invitationId: string; url: string }>(
      `/groups/${groupId}/invite`,
      { email },
    );
    assertStatus(res, 200, 'invite');
    if (!res.json.invitationId) fail('invite response had no invitationId');
    if (!res.json.url.endsWith(`/join/${res.json.invitationId}`)) {
      fail(`invite url ${res.json.url} does not end with /join/<id>`);
    }
    invitationId = res.json.invitationId;
    inviteUrl = res.json.url;

    const pending = await owner.get<{ id: string; email: string | null }[]>(
      `/groups/${groupId}/invitations`,
    );
    assertStatus(pending, 200, 'list pending invitations');
    if (!pending.json.some((i) => i.id === invitationId)) {
      fail('created invitation not found in the pending list');
    }

    const preview = await fetch(`${SERVER}/invitations/${invitationId}`);
    if (preview.status !== 200) {
      fail(`public invitation preview -> ${preview.status}, want 200`);
    }
    const previewBody = (await preview.json()) as {
      groupName: string;
      open: boolean;
    };
    if (!previewBody.open) fail('fresh invitation preview says not open');
    return inviteUrl;
  });

  await scenario(3, 'accept the invitation, signing up first', async () => {
    const email = `e2e-life-member-${ts}@example.test`;
    const s = new Session();
    const signUp = await s.post<{ user?: { id: string } }>(
      '/api/auth/sign-up/email',
      { email, password: 'password1', name: 'e2e member' },
    );
    assertStatus(signUp, 200, 'sign up the invited user');
    s.userId = signUp.json.user?.id ?? '';
    s.email = email;
    member = s;

    const accept = await s.post<{ groupId: string }>(
      `/invitations/${invitationId}/accept`,
    );
    assertStatus(accept, 200, 'accept invitation');
    if (accept.json.groupId !== groupId) {
      fail(`accepted into ${accept.json.groupId}, want ${groupId}`);
    }

    // Used-invitation message: one message, no second distinct shape.
    const replay = await s.post<{ reason?: string }>(
      `/invitations/${invitationId}/accept`,
    );
    if (replay.status !== 400)
      fail(`replayed accept -> ${replay.status}, want 400`);
    if (replay.json.reason !== 'This invitation is no longer open.') {
      fail(`replayed accept reason: ${JSON.stringify(replay.json)}`);
    }

    const members = await owner.get<{ userId: string; role: string }[]>(
      `/groups/${groupId}/members`,
    );
    if (
      !members.json.some((m) => m.userId === s.userId && m.role === 'member')
    ) {
      fail('accepted member not listed with role member');
    }
    return s.userId;
  });

  await scenario(
    4,
    'create a private board, gated before the allowlist change',
    async () => {
      if (!member) fail('scenario 3 did not sign up the member');
      const m = member;
      const res = await owner.post<{ id: string }>(
        `/groups/${groupId}/boards`,
        {
          name: 'e2e-life-private',
          open: false,
        },
      );
      assertStatus(res, 200, 'create private board');
      boardId = res.json.id;

      const denied = await m.get(`/boards/${boardId}`);
      if (denied.status !== 403) {
        fail(
          `member saw the private board before being allowlisted: ${denied.status}`,
        );
      }
      return boardId;
    },
  );

  await scenario(
    5,
    'allowlist change: add the member, then it can view',
    async () => {
      if (!member) fail('scenario 3 did not sign up the member');
      const m = member;
      const added = await owner.post<{ userId: string }[]>(
        `/boards/${boardId}/allowlist`,
        { userId: m.userId },
      );
      assertStatus(added, 200, 'add to allowlist');

      const full = await owner.get<{ members: { userId: string }[] }>(
        `/boards/${boardId}/allowlist`,
      );
      assertStatus(full, 200, 'GET allowlist');
      const ids = full.json.members.map((x) => x.userId).sort();
      if (
        JSON.stringify(ids) !== JSON.stringify([m.userId, owner.userId].sort())
      ) {
        fail(`allowlist is ${JSON.stringify(ids)}, want owner+member`);
      }

      const nowVisible = await m.get(`/boards/${boardId}`);
      assertStatus(
        nowVisible,
        200,
        'member views board after being allowlisted',
      );
      return '';
    },
  );

  await scenario(
    6,
    'upload an image and create a sheet with a claim',
    async () => {
      const dot = new Blob([new Uint8Array(onePixelPng())], {
        type: 'image/png',
      });
      const form = new FormData();
      form.append('files', dot, 'dot.png');
      const upload = await owner.postForm<{ id: string; status: string }[]>(
        `/boards/${boardId}/images?wait=0`,
        form,
      );
      assertStatus(upload, 202, 'upload one image');
      const imageId = upload.json[0]?.id;
      if (!imageId) fail('upload returned no image id');

      const sheet = await owner.post<{ id: string }>(
        `/boards/${boardId}/sheets`,
        {
          name: 'e2e-life-sheet',
          imageIds: [imageId],
        },
      );
      assertStatus(sheet, 200, 'create sheet');
      sheetId = sheet.json.id;
      return sheetId;
    },
  );

  await scenario(7, 'member leaves the group', async () => {
    if (!member) fail('scenario 3 did not sign up the member');
    const m = member;
    const left = await m.post(`/groups/${groupId}/leave`);
    assertStatus(left, 200, 'member leaves');

    const allowlist = await owner.get<{ members: { userId: string }[] }>(
      `/boards/${boardId}/allowlist`,
    );
    const ids = allowlist.json.members.map((x) => x.userId);
    if (ids.includes(m.userId)) {
      fail(
        'member still on the private board allowlist after leaving the group',
      );
    }

    const soleOwner = await owner.post<{ reason?: string }>(
      `/groups/${groupId}/leave`,
    );
    if (soleOwner.status !== 400) {
      fail(`sole owner leave -> ${soleOwner.status}, want 400`);
    }
    return '';
  });

  await scenario(8, 'delete the board with claims on it', async () => {
    const footprint = await owner.get<{
      images: number;
      sheets: number;
      regions: number;
      edges: number;
    }>(`/boards/${boardId}/footprint`);
    assertStatus(footprint, 200, 'board footprint');
    if (footprint.json.images !== 1 || footprint.json.sheets !== 1) {
      fail(
        `footprint ${JSON.stringify(footprint.json)}, want images:1 sheets:1`,
      );
    }

    const boardDir = join(DATA_DIR, 'boards', boardId);
    const hadFiles = existsSync(boardDir);

    const deleted = await owner.del(`/boards/${boardId}`);
    assertStatus(deleted, 200, 'delete board');

    const gone = await owner.get(`/boards/${boardId}`);
    if (gone.status !== 403) {
      // boardForDeleting/boardForViewing both 403 a board that no longer
      // exists (existence must not leak — access-one-function-per-intent.md);
      // a deleted board reads the same as one you were never on.
      fail(`GET a deleted board -> ${gone.status}, want 403`);
    }

    if (hadFiles && existsSync(boardDir)) {
      fail(`board directory ${boardDir} still exists after delete`);
    }
    return hadFiles
      ? 'files swept'
      : 'no local files to check (remote DATA_DIR?)';
  });

  await scenario(9, 'delete a sheet on a still-live board', async () => {
    const board2 = await owner.post<{ id: string }>(
      `/groups/${groupId}/boards`,
      {
        name: 'e2e-life-open',
        open: true,
      },
    );
    assertStatus(board2, 200, 'create second board');
    const board2Id = board2.json.id;

    const dot = new Blob([new Uint8Array(onePixelPng())], {
      type: 'image/png',
    });
    const form = new FormData();
    form.append('files', dot, 'dot2.png');
    const upload = await owner.postForm<{ id: string }[]>(
      `/boards/${board2Id}/images?wait=0`,
      form,
    );
    assertStatus(upload, 202, 'upload for second board');
    const imageId = upload.json[0]?.id;
    if (!imageId) fail('second upload returned no image id');

    const sheet2 = await owner.post<{ id: string }>(
      `/boards/${board2Id}/sheets`,
      {
        name: 'e2e-life-sheet-2',
        imageIds: [imageId],
      },
    );
    assertStatus(sheet2, 200, 'create second sheet');
    const sheet2Id = sheet2.json.id;

    const deleted = await owner.del(`/sheets/${sheet2Id}`);
    assertStatus(deleted, 200, 'delete sheet');

    // sheetForEditing denies a sheet it cannot find with the same 403 as a
    // real one you may not see (existence must not leak — .claude/rules/
    // access-one-function-per-intent.md), same as scenario 8's deleted
    // board.
    const gone = await owner.get(`/sheets/${sheet2Id}`);
    if (gone.status !== 403)
      fail(`GET a deleted sheet -> ${gone.status}, want 403`);

    const stillListed = await owner.get<{ id: string }[]>(
      `/boards/${board2Id}/sheets`,
    );
    if (stillListed.json.some((s) => s.id === sheet2Id)) {
      fail('deleted sheet still appears in the board sheet list');
    }
    return '';
  });

  console.log('');
  const failed = results.filter((r) => !r.pass);
  console.log(
    `${results.length - failed.length}/${results.length} scenarios passed`,
  );
  if (failed.length > 0)
    console.log(`FAILED: ${failed.map((r) => r.n).join(', ')}`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('groups-life crashed:', err);
  process.exit(1);
});
