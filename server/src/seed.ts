// The dev fixture, built through the real HTTP API against a running
// server (`bun run dev` or `bun run start` first) — same approach as
// ../../../prototype/groups/server/seed.ts. Idempotent: if group "Lab"
// already exists for `owner`, this is a no-op.
import { createCanvas } from '@napi-rs/canvas';
import './env.ts';
import { env } from './env.ts';

const BASE = env.SERVER_ORIGIN;

type ApiResult = { status: number; json: unknown };

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
    init: { form?: FormData; json?: unknown } = {},
  ): Promise<ApiResult> {
    const headers: Record<string, string> = { Origin: BASE };
    if (this.cookie) headers.cookie = this.cookie;
    let body: FormData | string | undefined;
    if (init.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(init.json);
    } else if (init.form !== undefined) {
      body = init.form;
    }
    const res = await fetch(`${BASE}${path}`, { method, headers, body });
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
  postForm(path: string, form: FormData) {
    return this.raw('POST', path, { form });
  }
}

type SignedIn = { session: Session; userId: string };

async function signUpOrIn(
  email: string,
  password: string,
  name: string,
): Promise<SignedIn> {
  const s = new Session();
  const up = await s.post('/api/auth/sign-up/email', { email, password, name });
  if (up.status === 200) {
    const body = up.json as { user: { id: string } };
    return { session: s, userId: body.user.id };
  }
  const inn = await s.post('/api/auth/sign-in/email', { email, password });
  if (inn.status !== 200) {
    throw new Error(
      `sign-in failed for ${email}: ${inn.status} ${JSON.stringify(inn.json)}`,
    );
  }
  const body = inn.json as { user: { id: string } };
  return { session: s, userId: body.user.id };
}

async function inviteAndAccept(
  inviter: SignedIn,
  groupId: string,
  email: string,
  name: string,
): Promise<SignedIn> {
  const invite = await inviter.session.post(`/groups/${groupId}/invite`, {
    email,
  });
  if (invite.status !== 200) {
    throw new Error(
      `invite ${email} failed: ${invite.status} ${JSON.stringify(invite.json)}`,
    );
  }
  const invited = await signUpOrIn(email, 'password1', name);
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

function paintSyntheticImage(index: number): Buffer {
  const size = 200 + (index % 5) * 60; // varied sizes, 200..440
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const hue = (index * 137.508) % 360;

  ctx.fillStyle = `hsl(${hue}, 65%, 55%)`;
  ctx.fillRect(0, 0, size, size);

  ctx.strokeStyle = `hsl(${hue}, 65%, 30%)`;
  ctx.lineWidth = Math.max(2, size * 0.05);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(size, size);
  ctx.stroke();

  ctx.fillStyle = 'rgba(0,0,0,0.85)';
  ctx.font = `${Math.round(size * 0.14)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(index), size / 2, size / 2);

  return canvas.encodeSync('png');
}

async function main() {
  const owner = await signUpOrIn('owner@example.test', 'password1', 'owner');

  const existing = await owner.session.get('/groups');
  if (
    existing.status === 200 &&
    Array.isArray(existing.json) &&
    existing.json.some((g: { name: string }) => g.name === 'Lab')
  ) {
    console.log('fixture already seeded ("Lab" exists), skipping');
    return;
  }

  const lab = await owner.session.post('/groups', { name: 'Lab' });
  if (lab.status !== 200)
    throw new Error(
      `create Lab failed: ${lab.status} ${JSON.stringify(lab.json)}`,
    );
  const labId = withId(lab.json).id;
  console.log('group "Lab" ->', labId);

  const member = await inviteAndAccept(
    owner,
    labId,
    'member@example.test',
    'member',
  );
  const listed = await inviteAndAccept(
    owner,
    labId,
    'listed@example.test',
    'listed',
  );

  const outsider = await signUpOrIn(
    'outsider@example.test',
    'password1',
    'outsider',
  );
  const other = await outsider.session.post('/groups', { name: 'Other' });
  if (other.status !== 200)
    throw new Error(
      `create Other failed: ${other.status} ${JSON.stringify(other.json)}`,
    );
  const otherId = withId(other.json).id;
  console.log('group "Other" ->', otherId);

  const field = await member.session.post(`/groups/${labId}/boards`, {
    name: 'Field',
    open: true,
  });
  if (field.status !== 200)
    throw new Error(
      `create Field failed: ${field.status} ${JSON.stringify(field.json)}`,
    );
  const fieldId = withId(field.json).id;
  console.log('board "Field" (open, by member) ->', fieldId);

  const finds = await owner.session.post(`/groups/${labId}/boards`, {
    name: 'Finds',
    open: false,
  });
  if (finds.status !== 200)
    throw new Error(
      `create Finds failed: ${finds.status} ${JSON.stringify(finds.json)}`,
    );
  const findsId = withId(finds.json).id;
  console.log('board "Finds" (private, by owner) ->', findsId);

  const allow = await owner.session.post(`/boards/${findsId}/allowlist`, {
    userId: listed.userId,
  });
  if (allow.status !== 200) {
    throw new Error(
      `allowlist listed on Finds failed: ${allow.status} ${JSON.stringify(allow.json)}`,
    );
  }
  console.log('listed added to Finds allowlist');

  const form = new FormData();
  for (let i = 0; i < 60; i++) {
    const png = paintSyntheticImage(i);
    form.append(
      'files',
      new Blob([png], { type: 'image/png' }),
      `image-${i}.png`,
    );
  }
  const uploadRes = await member.session.postForm(
    `/boards/${fieldId}/images`,
    form,
  );
  if (uploadRes.status !== 200) {
    throw new Error(
      `upload to Field failed: ${uploadRes.status} ${JSON.stringify(uploadRes.json)}`,
    );
  }
  const uploaded = uploadRes.json as { id: string; slot: number }[];
  console.log(`uploaded ${uploaded.length} images to Field`);

  for (const img of uploaded) {
    const properties = {
      year: 1900 + (img.slot % 60),
      site: `site-${img.slot % 5}`,
    };
    const patch = await member.session.patch(`/images/${img.id}`, {
      properties,
    });
    if (patch.status !== 200) {
      throw new Error(
        `set properties failed for slot ${img.slot}: ${patch.status}`,
      );
    }
  }
  console.log('properties set on all 60 images');

  const bySlot = new Map(uploaded.map((u) => [u.slot, u.id]));
  const firstPassIds = Array.from({ length: 12 }, (_, i) =>
    bySlot.get(i),
  ).filter((id): id is string => !!id);
  const facesIds = Array.from({ length: 12 }, (_, i) =>
    bySlot.get(i + 6),
  ).filter((id): id is string => !!id);

  const firstPass = await member.session.post(`/boards/${fieldId}/sheets`, {
    name: 'First pass',
    imageIds: firstPassIds,
  });
  if (firstPass.status !== 200) {
    throw new Error(
      `create sheet "First pass" failed: ${firstPass.status} ${JSON.stringify(firstPass.json)}`,
    );
  }

  const faces = await member.session.post(`/boards/${fieldId}/sheets`, {
    name: 'Faces',
    imageIds: facesIds,
  });
  if (faces.status !== 200) {
    throw new Error(
      `create sheet "Faces" failed: ${faces.status} ${JSON.stringify(faces.json)}`,
    );
  }

  console.log('sheets "First pass" and "Faces" created on Field');
  console.log('seed complete');
  console.log(
    JSON.stringify(
      {
        users: {
          owner: owner.userId,
          member: member.userId,
          listed: listed.userId,
          outsider: outsider.userId,
        },
        groups: { Lab: labId, Other: otherId },
        boards: { Field: fieldId, Finds: findsId },
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error('seed failed:', err);
  process.exit(1);
});
