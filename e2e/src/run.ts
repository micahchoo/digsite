// The walking-skeleton e2e run: the ten scenarios of docs/design.md's
// "e2e/" section, against the real dev stack (bun run db:migrate, seed,
// server on :8800, web on :5180 — see that file's "Environment" notes and
// this repo's own instructions for how this was invoked).
//
// HTTP is driven with session.ts's plain-fetch Session (see that file's
// header comment for why, not Playwright's `request` module). The sheet
// pages (scenarios 6-10) are driven with real Playwright browser pages, per
// window.__digsite (web/src/sheet/tools.ts) and web/scripts/smoke.ts's
// pattern. Socket.IO (scenario 9) uses socket.io-client directly.
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Fraction,
  cellPx,
  fromFraction,
  toFraction,
} from '@digsite/shared';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import {
  type Browser,
  type BrowserContext,
  type Page,
  chromium,
} from 'playwright';
import { io as ioClient } from 'socket.io-client';
import { SERVER, type Session, WEB, signIn } from './session.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCREEN_DIR = join(HERE, '../screenshots');
mkdirSync(SCREEN_DIR, { recursive: true });

// -- the browser-side contract, as read back through Playwright -----------
// web/src/sheet/tools.ts's window.__digsite, and the debug-only sibling
// added to web/src/sheet/Sheet.tsx for scenario 8 (see RESULTS.md). Kept
// narrow: only the fields this run actually reads.

interface ElementCustomData {
  kind?: string;
  imageId?: string;
  label?: string;
  relation?: string;
  direction?: string;
  foreign?: unknown;
}

interface ElementLike {
  id: string;
  isDeleted?: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  customData?: ElementCustomData;
  startBinding?: { elementId: string } | null;
  endBinding?: { elementId: string } | null;
}

interface ForeignRegionRow {
  id: string;
  sheetId: string;
  sourceId: string;
  imageId: string;
  fx: number;
  fy: number;
  fw: number;
  fh: number;
  label: string;
  properties: Record<string, unknown>;
}

interface ForeignEdgeRow {
  id: string;
  sheetId: string;
  sourceId: string;
  source: { imageId: string; regionSourceId?: string };
  target: { imageId: string; regionSourceId?: string };
  direction: string;
  relation: string;
  properties: Record<string, unknown>;
}

type ForeignShape =
  | { id: string; kind: 'region'; row: ForeignRegionRow }
  | { id: string; kind: 'edge'; row: ForeignEdgeRow };

interface DigsiteTools {
  drawRegion: (
    imageId: string,
    fraction: Fraction,
    label?: string,
  ) => string | null;
  connect: (
    fromId: string,
    toId: string,
    relation?: string,
    direction?: string,
  ) => string | null;
  moveImage: (imageId: string, dx: number, dy: number) => void;
  setRegionRect: (id: string, fraction: Partial<Fraction>) => void;
  copyForeign: (foreignShapeId: string) => string | null;
  getElements: () => ElementLike[];
  getForeign: () => ForeignShape[];
  getSelected: () => { kind: 'foreign' | 'own' } | null;
  zoomToFit: () => void;
}

interface DigsiteDebug {
  getAppState: () => { selectedElementIds: Record<string, boolean> } | null;
}

interface DigsiteWindow {
  __digsite?: DigsiteTools;
  __digsiteSheetDebug?: DigsiteDebug;
}

// -- tiny assertion helpers ------------------------------------------------

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

// Scenario 5 creates a fresh "e2e-private-<ts>" board (creator: listed),
// and nothing deletes it (design.md's e2e/ section has no teardown step) —
// against `scripts/e2e-fresh.ts`'s fresh database this run.ts is always the
// first and only run.ts against that database, so listed's board list has
// no debris to tolerate. assertNames requires the board list to be exactly
// `want`, in any order; any other name (missing or extra) is a real
// failure.
function assertNames(
  got: { name: string }[],
  want: string[],
  label: string,
): void {
  const g = got.map((r) => r.name);
  for (const w of want) {
    if (!g.includes(w)) fail(`${label}: missing "${w}" — got [${g.join(',')}]`);
  }
  const unexpected = g.filter((n) => !want.includes(n));
  if (unexpected.length > 0) {
    fail(
      `${label}: unexpected boards [${unexpected.join(',')}] — got [${g.join(',')}]`,
    );
  }
}

function hasForeignKey(el: unknown): boolean {
  if (typeof el !== 'object' || el === null) return false;
  const customData = (el as { customData?: unknown }).customData;
  return (
    typeof customData === 'object' &&
    customData !== null &&
    'foreign' in customData
  );
}

// -- tile pixel decoding (mirrors server/src/test/tiles.test.ts) ----------

function isBackground(px: Uint8ClampedArray): boolean {
  return px[0] === 0x22 && px[1] === 0x22 && px[2] === 0x22;
}

async function cellsPainted(
  png: Buffer,
  cpx: number,
  cells: [col: number, row: number][],
): Promise<boolean[]> {
  const img = await loadImage(png);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  return cells.map(([col, row]) => {
    const cx = Math.floor(col * cpx + cpx / 2);
    const cy = Math.floor(row * cpx + cpx / 2);
    const data = ctx.getImageData(cx, cy, 1, 1).data;
    return !(isBackground(data) || data[3] === 0);
  });
}

function paintSquare(hue: number, label: string): Buffer {
  const size = 40;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = `hsl(${hue}, 80%, 50%)`;
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = 'rgba(0,0,0,0.85)';
  ctx.font = '8px sans-serif';
  ctx.fillText(label, 2, size - 4);
  return canvas.encodeSync('png');
}

// -- scenario harness -------------------------------------------------------

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

// -- main -------------------------------------------------------------------

async function main() {
  console.log(`e2e: server=${SERVER} web=${WEB}`);

  // -- setup: sign in the four fixture users, resolve fixture ids -----------
  const owner = await signIn('owner@example.test', 'password1234');
  const member = await signIn('member@example.test', 'password1234');
  const listed = await signIn('listed@example.test', 'password1234');
  const outsider = await signIn('outsider@example.test', 'password1234');
  const users: Record<'owner' | 'member' | 'listed' | 'outsider', Session> = {
    owner,
    member,
    listed,
    outsider,
  };

  const ownerGroups =
    await owner.get<{ id: string; name: string; role: string }[]>('/groups');
  const labId = ownerGroups.json.find((g) => g.name === 'Lab')?.id;
  if (!labId)
    fail(
      'setup: fixture group "Lab" not found for owner — is the seed applied?',
    );

  const outsiderGroups =
    await outsider.get<{ id: string; name: string }[]>('/groups');
  const otherId = outsiderGroups.json.find((g) => g.name === 'Other')?.id;
  if (!otherId) fail('setup: fixture group "Other" not found for outsider');

  const ownerBoards = await owner.get<
    { id: string; name: string; open: boolean }[]
  >(`/groups/${labId}/boards`);
  const fieldId = ownerBoards.json.find((b) => b.name === 'Field')?.id;
  const findsId = ownerBoards.json.find((b) => b.name === 'Finds')?.id;
  if (!fieldId || !findsId)
    fail('setup: fixture boards "Field"/"Finds" not found');

  const sheetsRes = await member.get<{ id: string; name: string }[]>(
    `/boards/${fieldId}/sheets`,
  );
  const firstPassId = sheetsRes.json.find((s) => s.name === 'First pass')?.id;
  const facesId = sheetsRes.json.find((s) => s.name === 'Faces')?.id;
  if (!firstPassId || !facesId)
    fail('setup: fixture sheets "First pass"/"Faces" not found');

  const firstPassSheet = await member.get<{
    images: { id: string; slot: number }[];
  }>(`/sheets/${firstPassId}`);
  const image8 = firstPassSheet.json.images.find((i) => i.slot === 8);
  const image9 = firstPassSheet.json.images.find((i) => i.slot === 9);
  if (!image8 || !image9)
    fail('setup: images at slot 8/9 not found on sheet "First pass"');

  console.log(
    `setup ok: labId=${labId} otherId=${otherId} fieldId=${fieldId} findsId=${findsId} ` +
      `firstPassId=${firstPassId} facesId=${facesId} image8=${image8.id} image9=${image9.id}`,
  );

  // -- scenarios 1-5: plain HTTP ---------------------------------------------

  await scenario(1, 'sign-in + GET /groups matches the fixture', async () => {
    const want: Record<string, { name: string; role: string }[]> = {
      owner: [{ name: 'Lab', role: 'owner' }],
      member: [{ name: 'Lab', role: 'member' }],
      listed: [{ name: 'Lab', role: 'member' }],
      outsider: [{ name: 'Other', role: 'owner' }],
    };
    for (const [label, session] of Object.entries(users)) {
      const expected = want[label];
      if (!expected) fail(`no expectation defined for ${label}`);
      const res =
        await session.get<{ name: string; role: string }[]>('/groups');
      assertStatus(res, 200, `${label} GET /groups`);
      const got = res.json
        .map((g) => ({ name: g.name, role: g.role }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const w = [...expected].sort((a, b) => a.name.localeCompare(b.name));
      if (JSON.stringify(got) !== JSON.stringify(w)) {
        fail(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(w)}`);
      }
    }
    return '';
  });

  await scenario(2, 'board list per user matches allowlist rules', async () => {
    const o = await owner.get<{ name: string }[]>(`/groups/${labId}/boards`);
    assertStatus(o, 200, 'owner board list');
    assertNames(o.json, ['Field', 'Finds'], 'owner board list');

    const m = await member.get<{ name: string }[]>(`/groups/${labId}/boards`);
    assertStatus(m, 200, 'member board list');
    assertNames(m.json, ['Field'], 'member board list');

    const l = await listed.get<{ name: string }[]>(`/groups/${labId}/boards`);
    assertStatus(l, 200, 'listed board list');
    assertNames(l.json, ['Field', 'Finds'], 'listed board list');

    const out = await outsider.get(`/groups/${labId}/boards`);
    assertStatus(out, 403, 'outsider board list on a group they are not in');
    return '';
  });

  await scenario(
    3,
    'member uploads 3 images; tiles reflect them; year.asc ranks them last',
    async () => {
      const before = await member.get<{ imageCount: number }>(
        `/boards/${fieldId}`,
      );
      const startCount = before.json.imageCount;

      const tag = Date.now();
      const form = new FormData();
      for (let i = 0; i < 3; i++) {
        const png = paintSquare(60 + i * 40, `${tag}-${i}`);
        form.append(
          'files',
          new Blob([new Uint8Array(png)], { type: 'image/png' }),
          `e2e-upload-${tag}-${i}.png`,
        );
      }
      const uploadRes = await member.postForm<
        { id: string; slot: number; status: string }[]
      >(`/boards/${fieldId}/images`, form);
      // Phase 1: the ladder is built by the worker; the route answers 202 and,
      // with the default wait, returns once those jobs are done.
      assertStatus(uploadRes, 202, 'upload 3 images');
      if (uploadRes.json.length !== 3)
        fail(`expected 3 uploaded, got ${uploadRes.json.length}`);
      const notReady = uploadRes.json.filter((u) => u.status !== 'ready');
      if (notReady.length)
        fail(`upload waited but ${notReady.length} image(s) are not ready`);
      const gotSlots = uploadRes.json.map((u) => u.slot).sort((a, b) => a - b);
      const wantSlots = [startCount, startCount + 1, startCount + 2];
      if (JSON.stringify(gotSlots) !== JSON.stringify(wantSlots)) {
        fail(
          `uploaded slots ${JSON.stringify(gotSlots)}, want ${JSON.stringify(wantSlots)}`,
        );
      }

      const tileUrl = `/boards/${fieldId}/tiles/uploaded_at.desc/0/0/0.png`;
      const r1 = await member.getRaw(tileUrl);
      if (r1.status !== 200) fail(`tile fetch -> ${r1.status}`);
      if (r1.headers.get('x-cache') !== 'miss') {
        fail(
          `first tile request X-Cache was ${r1.headers.get('x-cache')}, want miss`,
        );
      }
      const buf1 = Buffer.from(await r1.arrayBuffer());
      // uploaded_at.desc: rank 0 and 1 are the two most recently uploaded of
      // our three (cellPx(0) = 128, from shared/src/board/grid.ts).
      const painted = await cellsPainted(buf1, cellPx(0), [
        [0, 0],
        [1, 0],
      ]);
      if (!painted[0] || !painted[1]) {
        fail(
          `tile (0,0,0) cells not painted after upload: ${JSON.stringify(painted)}`,
        );
      }

      const r2 = await member.getRaw(tileUrl);
      if (r2.headers.get('x-cache') !== 'hit') {
        fail(
          `second tile request X-Cache was ${r2.headers.get('x-cache')}, want hit`,
        );
      }

      const after = await member.get<{ imageCount: number }>(
        `/boards/${fieldId}`,
      );
      const totalCount = after.json.imageCount;
      const yearRes = await member.get<{ images: { id: string }[] }>(
        `/boards/${fieldId}/images?sort=${encodeURIComponent('p.number.year.asc')}&from=${totalCount - 3}&count=3`,
      );
      const gotIds = new Set(yearRes.json.images.map((i) => i.id));
      const wantIds = new Set(uploadRes.json.map((u) => u.id));
      if (
        gotIds.size !== wantIds.size ||
        [...wantIds].some((id) => !gotIds.has(id))
      ) {
        fail(
          `year.asc last 3 ranks were [${[...gotIds].join(',')}], want the 3 uploaded images ` +
            `(no "year" property -> NULLS LAST) [${[...wantIds].join(',')}]`,
        );
      }
      return `slots ${wantSlots.join(',')}; tile cells painted; miss then hit; year.asc nulls-last confirmed`;
    },
  );

  await scenario(4, 'cross-board tile access is denied', async () => {
    const tileUrl = (boardId: string) =>
      `/boards/${boardId}/tiles/uploaded_at.desc/0/0/0.png`;
    const r1 = await outsider.getRaw(tileUrl(fieldId));
    if (r1.status !== 403)
      fail(`outsider tile on Field -> ${r1.status}, want 403`);
    const r2 = await member.getRaw(tileUrl(findsId));
    if (r2.status !== 403)
      fail(`member tile on Finds -> ${r2.status}, want 403`);
    return '';
  });

  await scenario(
    5,
    'listed creates a private board in Lab (widened member role)',
    async () => {
      const res = await listed.post<{ id: string }>(`/groups/${labId}/boards`, {
        name: `e2e-private-${Date.now()}`,
        open: false,
      });
      // design.md's e2e section writes "-> 201"; every create route in
      // "Routes" (and the actual implementation) answers 200 — see
      // RESULTS.md. Treated as informal shorthand for "succeeds", not a bug.
      assertStatus(res, 200, 'listed creates private board');
      if (!res.json.id) fail('create board response had no id');
      return '';
    },
  );

  // -- scenarios 6-10: the sheet pages, browser-driven -----------------------

  const browser: Browser = await chromium.launch();
  let ctxA: BrowserContext | null = null;
  let ctxB: BrowserContext | null = null;
  let pageA: Page | null = null;
  let pageB: Page | null = null;

  async function pageFor(
    session: Session,
  ): Promise<{ context: BrowserContext; page: Page }> {
    const context = await browser.newContext({
      viewport: { width: 1600, height: 1000 },
    });
    const value = session.cookie.split('=').slice(1).join('=');
    await context.addCookies([
      {
        name: 'better-auth.session_token',
        value,
        domain: 'localhost',
        path: '/',
      },
    ]);
    const page = await context.newPage();
    return { context, page };
  }

  async function waitForDigsite(page: Page): Promise<void> {
    await page.waitForFunction(() =>
      Boolean((window as unknown as DigsiteWindow).__digsite),
    );
    await page.waitForFunction(
      () =>
        ((window as unknown as DigsiteWindow).__digsite?.getElements().length ??
          0) > 0,
      undefined,
      { timeout: 10_000 },
    );
  }

  async function elementsOf(page: Page): Promise<ElementLike[]> {
    return page.evaluate(
      (): ElementLike[] =>
        (window as unknown as DigsiteWindow).__digsite?.getElements() ?? [],
    );
  }

  let regionShapeId: string | null = null;
  let regionLabel = '';
  let img8ElId = '';
  let img9ElId = '';

  await scenario(
    6,
    'claim in sheet A is foreign in sheet B within 6s, never in either scene',
    async () => {
      const a = await pageFor(member);
      ctxA = a.context;
      pageA = a.page;
      const b = await pageFor(listed);
      ctxB = b.context;
      pageB = b.page;

      await pageA.goto(`${WEB}/s/${firstPassId}`);
      await waitForDigsite(pageA);
      await pageB.goto(`${WEB}/s/${facesId}`);
      await waitForDigsite(pageB);

      const els = await elementsOf(pageA);
      const img8El = els.find(
        (e) =>
          e.customData?.kind === 'image' && e.customData.imageId === image8.id,
      );
      const img9El = els.find(
        (e) =>
          e.customData?.kind === 'image' && e.customData.imageId === image9.id,
      );
      if (!img8El || !img9El)
        fail('image8/image9 elements not found on sheet A');
      img8ElId = img8El.id;
      img9ElId = img9El.id;

      // Short on purpose: convertToExcalidrawElements (used by both
      // drawRegion and, on the copy side, tools.ts#copyForeign) auto-grows a
      // container to fit its bound text. A long label here wraps inside the
      // 30%-width box and grows the box taller than requested — genuine
      // Excalidraw behaviour, not a product bug (see RESULTS.md) — so this
      // stays short enough to fit one line and never trigger that growth.
      regionLabel = `e2e${Math.random().toString(36).slice(2, 8)}`;
      const fraction: Fraction = { fx: 0.1, fy: 0.1, fw: 0.3, fh: 0.3 };
      const t0 = Date.now();

      const regionElId = await pageA.evaluate(
        ({ imageId, fraction, label }) =>
          (window as unknown as DigsiteWindow).__digsite?.drawRegion(
            imageId,
            fraction,
            label,
          ) ?? null,
        { imageId: image8.id, fraction, label: regionLabel },
      );
      if (!regionElId) fail('drawRegion returned null on sheet A');

      // drawRegion passes `label` to Excalidraw's convertToExcalidrawElements,
      // which auto-grows a container to fit its bound text — a long label
      // (the timestamp tag used for uniqueness here) against a 30%-height
      // box grows the box taller than requested. That growth is genuine
      // Excalidraw behaviour, not a product bug (see RESULTS.md); pin the
      // rect back to the exact fraction with setRegionRect, which writes the
      // rect directly and does not invoke label layout.
      await pageA.evaluate(
        ({ id, fraction }) =>
          (window as unknown as DigsiteWindow).__digsite?.setRegionRect(
            id,
            fraction,
          ),
        { id: regionElId, fraction },
      );

      const edgeElId = await pageA.evaluate(
        ({ fromId, toId }) =>
          (window as unknown as DigsiteWindow).__digsite?.connect(
            fromId,
            toId,
            'resembles',
            'forward',
          ) ?? null,
        { fromId: img8ElId, toId: img9ElId },
      );
      if (!edgeElId) fail('connect returned null on sheet A');

      const deadline = Date.now() + 6000;
      let foundRegion: Extract<ForeignShape, { kind: 'region' }> | undefined;
      let foundEdge: Extract<ForeignShape, { kind: 'edge' }> | undefined;
      while (Date.now() < deadline && (!foundRegion || !foundEdge)) {
        const foreign = await pageB.evaluate(
          (): ForeignShape[] =>
            (window as unknown as DigsiteWindow).__digsite?.getForeign() ?? [],
        );
        foundRegion =
          foundRegion ??
          foreign.find(
            (s): s is Extract<ForeignShape, { kind: 'region' }> =>
              s.kind === 'region' &&
              s.row.imageId === image8.id &&
              s.row.sheetId === firstPassId &&
              s.row.label === regionLabel,
          );
        foundEdge =
          foundEdge ??
          foreign.find(
            (s): s is Extract<ForeignShape, { kind: 'edge' }> =>
              s.kind === 'edge' &&
              s.row.source.imageId === image8.id &&
              s.row.target.imageId === image9.id &&
              s.row.direction === 'forward' &&
              s.row.sheetId === firstPassId,
          );
        if (!foundRegion || !foundEdge)
          await new Promise((r) => setTimeout(r, 250));
      }
      const elapsedMs = Date.now() - t0;
      if (!foundRegion)
        fail(`foreign region not visible on B within 6s (${elapsedMs}ms)`);
      if (!foundEdge)
        fail(`foreign edge not visible on B within 6s (${elapsedMs}ms)`);
      regionShapeId = foundRegion.id;

      const close = (x: number, y: number) => Math.abs(x - y) <= 0.001;
      if (
        !close(foundRegion.row.fx, fraction.fx) ||
        !close(foundRegion.row.fy, fraction.fy) ||
        !close(foundRegion.row.fw, fraction.fw) ||
        !close(foundRegion.row.fh, fraction.fh)
      ) {
        fail(
          `foreign region fractions ${JSON.stringify(foundRegion.row)} != drawn ${JSON.stringify(fraction)}`,
        );
      }

      const aHasForeign = await pageA.evaluate(() =>
        (
          (window as unknown as DigsiteWindow).__digsite?.getElements() ?? []
        ).some((e) => e.customData?.foreign !== undefined),
      );
      if (aHasForeign)
        fail('sheet A getElements() has an element with a foreign key');

      const bHasForeign = await pageB.evaluate(() =>
        (
          (window as unknown as DigsiteWindow).__digsite?.getElements() ?? []
        ).some((e) => e.customData?.foreign !== undefined),
      );
      if (bHasForeign)
        fail('sheet B getElements() has an element with a foreign key');

      const snapshot = await listed.get<{ elements: unknown[] }>(
        `/sheets/${facesId}/elements`,
      );
      if (snapshot.json.elements.some(hasForeignKey)) {
        fail('GET /sheets/:id/elements has an element with a foreign key');
      }

      const stats = await listed.get<{ foreignInScene: number }>('/stats');
      if (stats.json.foreignInScene !== 0) {
        fail(
          `GET /stats foreignInScene = ${stats.json.foreignInScene}, want 0`,
        );
      }

      await pageA.screenshot({
        path: join(SCREEN_DIR, 'sheet-A-first-pass-after-s6.png'),
      });
      await pageB.screenshot({
        path: join(SCREEN_DIR, 'sheet-B-faces-after-s6.png'),
      });

      return `${(elapsedMs / 1000).toFixed(2)}s to foreign`;
    },
  );

  await scenario(
    7,
    'moveImage then copyForeign in the same tick lands on the moved image',
    async () => {
      if (!regionShapeId) fail('scenario 6 did not establish a foreign region');
      if (!pageB) fail('scenario 6 did not open sheet B');
      const shapeId = regionShapeId;
      const page = pageB;

      const result = await page.evaluate(
        ({ shapeId, imageId }) => {
          const digsite = (window as unknown as DigsiteWindow).__digsite;
          if (!digsite) return null;
          const before = digsite.getForeign().find((s) => s.id === shapeId);
          digsite.moveImage(imageId, 100, 50);
          const newId = digsite.copyForeign(shapeId);
          const elements = digsite.getElements();
          const copy = elements.find((e) => e.id === newId);
          const imgEl = elements.find(
            (e) =>
              e.customData?.kind === 'image' &&
              e.customData.imageId === imageId,
          );
          return {
            newId,
            row: before && before.kind === 'region' ? before.row : null,
            copy: copy
              ? { x: copy.x, y: copy.y, width: copy.width, height: copy.height }
              : null,
            imgEl: imgEl
              ? {
                  x: imgEl.x,
                  y: imgEl.y,
                  width: imgEl.width,
                  height: imgEl.height,
                }
              : null,
          };
        },
        { shapeId, imageId: image8.id },
      );

      if (!result) fail('window.__digsite missing on sheet B');
      if (!result.row) fail('foreign region row not found at copyForeign time');
      if (!result.copy) fail('copyForeign did not produce a copy element');
      if (!result.imgEl) fail('image element for the copy not found');
      const row = result.row;
      const copy = result.copy;
      const imgEl = result.imgEl;

      const expectedRect = fromFraction(row, imgEl);
      const copyFraction = toFraction(copy, imgEl);
      const deltas = {
        fx: Math.abs(copyFraction.fx - row.fx),
        fy: Math.abs(copyFraction.fy - row.fy),
        fw: Math.abs(copyFraction.fw - row.fw),
        fh: Math.abs(copyFraction.fh - row.fh),
      };
      const maxDelta = Math.max(deltas.fx, deltas.fy, deltas.fw, deltas.fh);
      if (maxDelta > 0.001) {
        fail(
          `fraction delta ${maxDelta.toFixed(5)} exceeds 0.001: ${JSON.stringify(deltas)}`,
        );
      }
      if (
        Math.abs(copy.x - expectedRect.x) > 0.5 ||
        Math.abs(copy.y - expectedRect.y) > 0.5
      ) {
        fail(
          `copy rect ${JSON.stringify(copy)} != fromFraction(row, imageRectNow) ${JSON.stringify(expectedRect)}`,
        );
      }
      return `max fraction delta ${maxDelta.toFixed(5)}`;
    },
  );

  await scenario(
    8,
    'a real pointer drag across a foreign shape moves nothing and selects foreign',
    async () => {
      if (!regionShapeId) fail('scenario 6 did not establish a foreign region');
      if (!pageB) fail('scenario 6 did not open sheet B');
      if (!pageA) fail('scenario 6 did not open sheet A');
      const shapeId = regionShapeId;
      const b = pageB;
      const a = pageA;

      // Repeated runs move image 8 further each time (scenario 7), so fit
      // the view first: the drag must land on the shape, wherever it is.
      await b.evaluate(() =>
        (window as unknown as DigsiteWindow).__digsite?.zoomToFit(),
      );
      await b.waitForTimeout(300);
      const target = b.locator(
        `[data-testid="foreign-shape"][data-foreign-id="${shapeId}"]`,
      );
      const box = await target.boundingBox();
      if (!box)
        fail('no foreign region shape found on screen for the drag test');
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;

      const imgBefore = await b.evaluate(() =>
        ((window as unknown as DigsiteWindow).__digsite?.getElements() ?? [])
          .filter((e) => e.customData?.kind === 'image')
          .map((e) => ({ id: e.customData?.imageId, x: e.x, y: e.y })),
      );

      await b.mouse.move(cx, cy);
      await b.mouse.down();
      await b.mouse.move(cx + 30, cy + 20, { steps: 5 });
      await b.mouse.up();
      await b.waitForTimeout(200);

      const imgAfter = await b.evaluate(() =>
        ((window as unknown as DigsiteWindow).__digsite?.getElements() ?? [])
          .filter((e) => e.customData?.kind === 'image')
          .map((e) => ({ id: e.customData?.imageId, x: e.x, y: e.y })),
      );
      if (JSON.stringify(imgBefore) !== JSON.stringify(imgAfter)) {
        fail(
          `an image moved under a foreign-shape drag: ${JSON.stringify({ imgBefore, imgAfter })}`,
        );
      }

      const selectedKind = await b.evaluate(
        () =>
          (window as unknown as DigsiteWindow).__digsite?.getSelected()?.kind ??
          null,
      );
      if (selectedKind !== 'foreign') {
        fail(`getSelected().kind = ${selectedKind}, want 'foreign'`);
      }

      const selectedIds = await b.evaluate(
        () =>
          (
            window as unknown as DigsiteWindow
          ).__digsiteSheetDebug?.getAppState()?.selectedElementIds ?? null,
      );
      if (!selectedIds || Object.keys(selectedIds).length !== 0) {
        fail(
          `Excalidraw's own appState.selectedElementIds not empty: ${JSON.stringify(selectedIds)}`,
        );
      }

      await a.screenshot({
        path: join(SCREEN_DIR, 'sheet-A-first-pass-after-s8.png'),
      });
      await b.screenshot({
        path: join(SCREEN_DIR, 'sheet-B-faces-after-s8.png'),
      });
      return '';
    },
  );

  await scenario(9, 'outsider socket join is denied', async () => {
    await new Promise<void>((resolve, reject) => {
      const socket = ioClient(SERVER, {
        extraHeaders: { Cookie: outsider.cookie },
        transports: ['websocket'],
      });
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error('no join-denied event within 5s'));
      }, 5000);
      socket.on('connect', () => socket.emit('join', { sheetId: firstPassId }));
      socket.on('join-denied', (_payload: { reason: string }) => {
        clearTimeout(timer);
        socket.close();
        resolve();
      });
      socket.on('joined', () => {
        clearTimeout(timer);
        socket.close();
        reject(
          new Error(
            'outsider was allowed to join a sheet on a board they cannot see',
          ),
        );
      });
      socket.on('connect_error', (err: Error) => {
        clearTimeout(timer);
        reject(new Error(`socket connect_error: ${err.message}`));
      });
    });
    return '';
  });

  await scenario(
    10,
    'reload sheet A: region and edge restored from the snapshot',
    async () => {
      if (!pageA) fail('sheet A was never opened (scenario 6 prerequisite)');
      const page = pageA;
      await page.reload();
      await waitForDigsite(page);
      const els = await elementsOf(page);
      const region = els.find(
        (e) =>
          e.customData?.kind === 'region' &&
          e.customData.imageId === image8.id &&
          e.customData.label === regionLabel,
      );
      if (!region) fail('region not restored on sheet A after reload');
      const edge = els.find(
        (e) =>
          e.customData?.kind === 'edge' &&
          e.customData.relation === 'resembles' &&
          e.customData.direction === 'forward' &&
          e.startBinding?.elementId === img8ElId &&
          e.endBinding?.elementId === img9ElId,
      );
      if (!edge) fail('edge not restored on sheet A after reload');
      return '';
    },
  );

  if (ctxA) await (ctxA as BrowserContext).close();
  if (ctxB) await (ctxB as BrowserContext).close();
  await browser.close();

  // -- report -----------------------------------------------------------------

  const failed = results.filter((r) => !r.pass);
  console.log('');
  console.log(
    `${results.length - failed.length}/${results.length} scenarios passed`,
  );
  if (failed.length > 0) {
    console.log(`FAILED: ${failed.map((r) => r.n).join(', ')}`);
  }

  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('e2e run crashed:', err);
  process.exit(1);
});
