// A resumable upload via tus-js-client, for the definition-of-done check in
// docs/phases/1-map.md ("a tus upload via a small script completes and the
// image becomes ready"). Signs in with an email/password (defaults to the
// seed fixture's `member`), uploads one small synthetic PNG to
// `/boards/:id/uploads`, then polls the board's images until it shows
// ready.
//
//   bun run scripts/tus-upload.ts <boardId> [email] [password]
import { createCanvas } from '@napi-rs/canvas';
import { Upload } from 'tus-js-client';
import { env } from '../src/env.ts';

const boardId = process.argv[2];
const email = process.argv[3] ?? 'member@example.test';
const password = process.argv[4] ?? 'password1234';

if (!boardId) {
  console.error(
    'usage: bun run scripts/tus-upload.ts <boardId> [email] [password]',
  );
  process.exit(1);
}

function paintPng(): Buffer {
  const size = 64;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = `hsl(${Date.now() % 360}, 80%, 50%)`;
  ctx.fillRect(0, 0, size, size);
  return canvas.encodeSync('png');
}

async function signIn(): Promise<string> {
  const res = await fetch(`${env.SERVER_ORIGIN}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: env.SERVER_ORIGIN },
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 200) {
    throw new Error(`sign-in failed: ${res.status} ${await res.text()}`);
  }
  const setCookie = res.headers.get('set-cookie');
  const cookie = setCookie?.split(';')[0];
  if (!cookie) throw new Error('sign-in returned no session cookie');
  return cookie;
}

async function upload(cookie: string, bytes: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const tusUpload = new Upload(bytes, {
      endpoint: `${env.SERVER_ORIGIN}/boards/${boardId}/uploads`,
      headers: { cookie, Origin: env.SERVER_ORIGIN },
      metadata: {
        filename: `tus-upload-${Date.now()}.png`,
        properties: JSON.stringify({ source: 'tus-upload.ts' }),
      },
      onError: (err) => reject(err),
      onSuccess: () => resolve(tusUpload.url ?? ''),
    });
    tusUpload.start();
  });
}

async function waitForReady(cookie: string, deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const res = await fetch(
      `${env.SERVER_ORIGIN}/boards/${boardId}/images?sort=uploaded_at.desc&from=0&count=1`,
      { headers: { cookie } },
    );
    const body = (await res.json()) as {
      images?: { id: string; status?: string; uploadedAt: string }[];
    };
    const first = body.images?.[0];
    if (first)
      console.log(`  latest image: ${first.id} status=${first.status}`);
    if (first?.status === 'ready') return;
    if (first?.status === 'failed') throw new Error(`image ${first.id} failed`);
    if (Date.now() >= deadline) {
      throw new Error('timed out waiting for the tus upload to become ready');
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function main() {
  console.log(`signing in as ${email}`);
  const cookie = await signIn();

  console.log(`uploading to /boards/${boardId}/uploads via tus`);
  const url = await upload(cookie, paintPng());
  console.log(`tus upload finished: ${url}`);

  console.log('polling for status = ready (up to 15s)');
  await waitForReady(cookie, 15_000);
  console.log('done: the image is ready');
}

main().catch((err) => {
  console.error('tus-upload.ts failed:', err);
  process.exit(1);
});
