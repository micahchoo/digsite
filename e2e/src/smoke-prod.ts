// docs/phases/4-deploy.md section "Tests": five checks against a live
// deployment — sign up, upload, tile, sheet, foreign — self-contained
// (creates its own user/group/board/sheets rather than assuming
// server/src/seed.ts's fixture, which a real deploy never has).
//
// Run with:
//   PROD_ORIGIN=https://example.com bun run smoke:prod
// (root script — see package.json) or, from e2e/:
//   PROD_ORIGIN=https://example.com bun run src/smoke-prod.ts
// PROD_API_ORIGIN defaults to https://api.<PROD_ORIGIN's host> — the split
// deploy/Caddyfile serves (see that file's header for why it's a
// subdomain, not a path prefix); pass it explicitly for a different split.
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { type Browser, chromium } from 'playwright';

const WEB = process.env.PROD_ORIGIN;
if (!WEB) {
  console.error(
    'PROD_ORIGIN is required, e.g. PROD_ORIGIN=https://example.com',
  );
  process.exit(1);
}

function defaultApiOrigin(web: string): string {
  const u = new URL(web);
  u.hostname = `api.${u.hostname}`;
  return u.origin;
}

const SERVER = process.env.PROD_API_ORIGIN ?? defaultApiOrigin(WEB);

type ApiResult<T = unknown> = { status: number; json: T };

class Session {
  cookie = '';

  private async raw<T>(
    method: string,
    path: string,
    init: { form?: FormData; json?: unknown } = {},
  ): Promise<ApiResult<T>> {
    const headers: Record<string, string> = { Origin: WEB as string };
    if (this.cookie) headers.cookie = this.cookie;
    let body: FormData | string | undefined;
    if (init.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(init.json);
    } else if (init.form !== undefined) {
      body = init.form;
    }
    const res = await fetch(`${SERVER}${path}`, { method, headers, body });
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
    return { status: res.status, json: json as T };
  }

  get<T>(path: string) {
    return this.raw<T>('GET', path);
  }
  post<T>(path: string, json?: unknown) {
    return this.raw<T>('POST', path, { json });
  }
  postForm<T>(path: string, form: FormData) {
    return this.raw<T>('POST', path, { form });
  }

  async getRaw(path: string): Promise<Response> {
    const headers: Record<string, string> = { Origin: WEB as string };
    if (this.cookie) headers.cookie = this.cookie;
    return fetch(`${SERVER}${path}`, { headers });
  }
}

function fail(step: string, message: string): never {
  throw new Error(`${step}: ${message}`);
}

function paintSquare(hue: number): Buffer {
  const size = 64;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = `hsl(${hue}, 80%, 50%)`;
  ctx.fillRect(0, 0, size, size);
  return canvas.encodeSync('png');
}

function isBackground(px: Uint8ClampedArray): boolean {
  return px[0] === 0x22 && px[1] === 0x22 && px[2] === 0x22;
}

interface DigsiteTools {
  drawRegion: (
    imageId: string,
    fraction: { fx: number; fy: number; fw: number; fh: number },
    label?: string,
  ) => string | null;
  getElements: () => { customData?: { kind?: string; imageId?: string } }[];
}
interface DigsiteWindow {
  __digsite?: DigsiteTools;
}

async function main() {
  console.log(`smoke:prod web=${WEB} api=${SERVER}`);
  const ts = Date.now();

  // 1. sign up
  const session = new Session();
  const email = `smoke-${ts}@example.test`;
  const up = await session.post<{ user?: { id: string } }>(
    '/api/auth/sign-up/email',
    { email, password: `smoke-pass-${ts}`, name: 'smoke' },
  );
  if (up.status !== 200 || !up.json.user) {
    fail('sign up', `${up.status} ${JSON.stringify(up.json)}`);
  }
  console.log('PASS 1. sign up ->', up.json.user.id);

  const group = await session.post<{ id: string }>('/groups', {
    name: `smoke-${ts}`,
  });
  if (group.status !== 200 || !group.json.id) {
    fail(
      'sign up',
      `create group ${group.status} ${JSON.stringify(group.json)}`,
    );
  }
  const board = await session.post<{ id: string }>(
    `/groups/${group.json.id}/boards`,
    { name: 'smoke', open: true },
  );
  if (board.status !== 200 || !board.json.id) {
    fail(
      'sign up',
      `create board ${board.status} ${JSON.stringify(board.json)}`,
    );
  }
  const boardId = board.json.id;

  // 2. upload
  const form = new FormData();
  form.append(
    'files',
    new Blob([new Uint8Array(paintSquare(120))], { type: 'image/png' }),
    `smoke-${ts}.png`,
  );
  const uploadRes = await session.postForm<
    { id: string; slot: number; status: string }[]
  >(`/boards/${boardId}/images`, form);
  if (uploadRes.status !== 202 || uploadRes.json.length !== 1) {
    fail('upload', `${uploadRes.status} ${JSON.stringify(uploadRes.json)}`);
  }
  const image = uploadRes.json[0];
  if (!image || image.status !== 'ready') {
    fail('upload', `image did not reach ready: ${JSON.stringify(image)}`);
  }
  console.log('PASS 2. upload -> image', image.id, 'slot', image.slot);

  // 3. tile
  const tileUrl = `/boards/${boardId}/tiles/uploaded_at.desc/0/0/0.png`;
  const tileRes = await session.getRaw(tileUrl);
  if (tileRes.status !== 200) fail('tile', `${tileRes.status}`);
  const tileBuf = Buffer.from(await tileRes.arrayBuffer());
  const img = await loadImage(tileBuf);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(64, 64, 1, 1).data; // cellPx(0) = 128, so (64,64) is inside cell (0,0)
  if (isBackground(px)) fail('tile', 'cell (0,0) is background, not painted');
  console.log('PASS 3. tile -> cell (0,0) painted');

  // 4. sheet
  const sheetA = await session.post<{ id: string }>(
    `/boards/${boardId}/sheets`,
    {
      name: 'A',
      imageIds: [image.id],
    },
  );
  const sheetB = await session.post<{ id: string }>(
    `/boards/${boardId}/sheets`,
    {
      name: 'B',
      imageIds: [image.id],
    },
  );
  if (sheetA.status !== 200 || sheetB.status !== 200) {
    fail('sheet', `create sheets ${sheetA.status}/${sheetB.status}`);
  }
  console.log('PASS 4. sheet -> A', sheetA.json.id, 'B', sheetB.json.id);

  // 5. foreign: draw a region on sheet A (via the live page's own
  // window.__digsite, the only writer — see .claude/rules/
  // foreign-never-in-scene.md and web/src/sheet/tools.ts) and poll sheet
  // B's GET /sheets/:id/foreign until it shows up.
  const browser: Browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const cookieValue = session.cookie.split('=').slice(1).join('=');
    await context.addCookies([
      {
        name: 'better-auth.session_token',
        value: cookieValue,
        domain: new URL(WEB as string).hostname,
        path: '/',
      },
    ]);
    const page = await context.newPage();
    await page.goto(`${WEB}/s/${sheetA.json.id}`);
    await page.waitForFunction(
      () => Boolean((window as unknown as DigsiteWindow).__digsite),
      undefined,
      { timeout: 15_000 },
    );
    await page.waitForFunction(
      () =>
        ((window as unknown as DigsiteWindow).__digsite?.getElements().length ??
          0) > 0,
      undefined,
      { timeout: 15_000 },
    );
    const regionId = await page.evaluate(
      (imageId) =>
        (window as unknown as DigsiteWindow).__digsite?.drawRegion(
          imageId,
          { fx: 0.1, fy: 0.1, fw: 0.3, fh: 0.3 },
          `smoke-${Date.now()}`,
        ) ?? null,
      image.id,
    );
    if (!regionId) fail('foreign', 'drawRegion returned null on sheet A');

    const deadline = Date.now() + 8000;
    let found = false;
    while (Date.now() < deadline && !found) {
      const foreign = await session.get<{ regions: { imageId: string }[] }>(
        `/sheets/${sheetB.json.id}/foreign`,
      );
      found =
        foreign.json.regions?.some((r) => r.imageId === image.id) ?? false;
      if (!found) await new Promise((r) => setTimeout(r, 250));
    }
    if (!found)
      fail('foreign', 'region drawn on A never appeared as foreign on B');
    console.log('PASS 5. foreign -> visible on sheet B within 8s');

    await context.close();
  } finally {
    await browser.close();
  }

  console.log('\nsmoke:prod: 5/5 passed');
}

main().catch((err) => {
  console.error('smoke:prod FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
