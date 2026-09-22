// The sheet-hour run (docs/phases/2-sheet.md's Tests section, "the hour
// run"): two people work the same board's two sheets for what a real
// session would spend an hour on, compressed into a scripted run with
// random pauses, then checked for the invariants a live document has to
// hold. Written against the REAL server's contract — session.ts's Session,
// the fixture names ("Lab" / "Field" / "First pass" / "Faces"), the routes
// in server/src/sheets/{routes,room,neighbourhood}.ts — exactly like
// e2e/src/run.ts.
//
// `member` works "First pass", `listed` works "Faces"; both sheets hold
// images 6..11 (the stub's own SHEET_IMAGES fixture: s1 = 0..11, s2 =
// 6..17), so every action below has somewhere shared to land and something
// to see foreign on the other side.
//
// SERVER_ORIGIN/WEB_ORIGIN env exactly as session.ts reads them.
// HOUR_ACTIONS overrides the action count (default ~200; a dry run against
// the stub uses a small number, e.g. HOUR_ACTIONS=20, since there is no
// snapshot debounce to wait through there and the point is to exercise the
// script's own logic, not spend real minutes).
import { type SceneElement, project } from '@digsite/shared';
import {
  type Browser,
  type BrowserContext,
  type Page,
  chromium,
} from 'playwright';
import { type Session, WEB, signIn } from './session.ts';

const ACTIONS = Number(process.env.HOUR_ACTIONS) || 200;
const WAIT_MIN_MS = 50;
const WAIT_MAX_MS = 500;
// After the loop: the snapshot debounce (1,500ms on the real server, none
// on the stub) plus the foreign poll (<=3,000ms) — see room.ts/useForeign.ts.
const SETTLE_MS = 4000;

function fail(message: string): never {
  throw new Error(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function randomWait(): Promise<void> {
  return sleep(WAIT_MIN_MS + Math.random() * (WAIT_MAX_MS - WAIT_MIN_MS));
}

function pick<T>(arr: readonly T[]): T | undefined {
  return arr.length ? arr[Math.floor(Math.random() * arr.length)] : undefined;
}

// -- canonical comparison: key order and float precision must never fail an
// otherwise-correct row (server-side numeric storage can round differently
// than the client's own arithmetic) --------------------------------------
function canon(v: unknown): unknown {
  if (typeof v === 'number') return Math.round(v * 1e6) / 1e6;
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(o)
        .sort()
        .map((k) => [k, canon(o[k])]),
    );
  }
  return v;
}

function sortedById(rows: { id: string }[]): unknown[] {
  return [...rows].sort((a, b) => a.id.localeCompare(b.id)).map(canon);
}

function sameRows(a: { id: string }[], b: { id: string }[]): boolean {
  return JSON.stringify(sortedById(a)) === JSON.stringify(sortedById(b));
}

function stripSheetName<T extends { sheetName?: unknown }>(
  rows: T[],
): Omit<T, 'sheetName'>[] {
  return rows.map(({ sheetName: _sheetName, ...rest }) => rest);
}

// -- the browser-side contract, as read back through Playwright — same
// narrow slice as run.ts's own DigsiteTools ---------------------------------
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
  customData?: ElementCustomData;
}
interface ForeignShapeLike {
  id: string;
  kind: 'region' | 'edge';
}
interface DigsiteTools {
  drawRegion: (
    imageId: string,
    fraction: { fx: number; fy: number; fw: number; fh: number },
    label?: string,
  ) => string | null;
  connect: (
    fromId: string,
    toId: string,
    relation?: string,
    direction?: string,
  ) => string | null;
  moveImage: (imageId: string, dx: number, dy: number) => void;
  copyForeign: (foreignShapeId: string) => string | null;
  select: (id: string) => void;
  deleteSelected: () => void;
  setProperty: (id: string, key: string, value: unknown) => void;
  getElements: () => ElementLike[];
  getForeign: () => ForeignShapeLike[];
  getDangling: () => { id: string; relation: string }[];
  removeDangling: () => number;
}
interface DigsiteWindow {
  __digsite?: DigsiteTools;
}

async function elementsOf(page: Page): Promise<ElementLike[]> {
  return page.evaluate(
    (): ElementLike[] =>
      (window as unknown as DigsiteWindow).__digsite?.getElements() ?? [],
  );
}

// -- one worker: a page bound to one sheet, driving window.__digsite --------
interface Worker {
  label: string;
  page: Page;
  sheetId: string;
  images: string[]; // this sheet's own image ids, shared subset (slots 6..11)
}

async function ownImageElId(
  worker: Worker,
  imageId: string,
): Promise<string | null> {
  const els = await elementsOf(worker.page);
  return (
    els.find(
      (e) => e.customData?.kind === 'image' && e.customData.imageId === imageId,
    )?.id ?? null
  );
}

async function doAction(worker: Worker): Promise<void> {
  const els = await elementsOf(worker.page);
  const images = els.filter((e) => e.customData?.kind === 'image');
  const regions = els.filter((e) => e.customData?.kind === 'region');
  const edges = els.filter((e) => e.customData?.kind === 'edge');
  const connectable = els.filter(
    (e) => e.customData?.kind === 'image' || e.customData?.kind === 'region',
  );

  const kinds = [
    'draw',
    'move',
    'relabel',
    'connect',
    'delete-region',
    'copy-foreign',
    'remove-dangling',
    'undo',
  ] as const;
  const kind = pick(kinds);

  await worker.page.evaluate(
    async ({ kind, images, regions, edges, connectable }) => {
      const digsite = (window as unknown as DigsiteWindow).__digsite;
      if (!digsite) return;

      function pickOne<T>(arr: T[]): T | undefined {
        return arr.length
          ? arr[Math.floor(Math.random() * arr.length)]
          : undefined;
      }

      if (kind === 'draw' && images.length) {
        const img = pickOne(images);
        if (!img?.customData?.imageId) return;
        const fx = Math.random() * 0.5;
        const fy = Math.random() * 0.5;
        digsite.drawRegion(
          img.customData.imageId,
          { fx, fy, fw: 0.2, fh: 0.2 },
          `r${Math.random().toString(36).slice(2, 8)}`,
        );
      } else if (kind === 'move' && images.length) {
        const img = pickOne(images);
        if (!img?.customData?.imageId) return;
        digsite.moveImage(
          img.customData.imageId,
          Math.round(Math.random() * 60 - 30),
          Math.round(Math.random() * 60 - 30),
        );
      } else if (kind === 'relabel') {
        const region = pickOne(regions);
        const edge = pickOne(edges);
        if (region) {
          digsite.setProperty(
            region.id,
            'label',
            `relabel-${Math.random().toString(36).slice(2, 6)}`,
          );
        } else if (edge) {
          digsite.setProperty(
            edge.id,
            'relation',
            `relabel-${Math.random().toString(36).slice(2, 6)}`,
          );
        }
      } else if (kind === 'connect' && connectable.length >= 2) {
        const a = pickOne(connectable);
        const b = pickOne(connectable.filter((e) => e.id !== a?.id));
        if (a && b) digsite.connect(a.id, b.id, 'hour-run', 'forward');
      } else if (kind === 'delete-region' && regions.length) {
        const region = pickOne(regions);
        if (!region) return;
        digsite.select(region.id);
        digsite.deleteSelected();
      } else if (kind === 'copy-foreign') {
        const foreign = digsite.getForeign();
        const shape = pickOne(foreign);
        if (shape) digsite.copyForeign(shape.id);
      } else if (kind === 'remove-dangling') {
        digsite.removeDangling();
      } else if (kind === 'undo') {
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'z',
            ctrlKey: true,
            bubbles: true,
          }),
        );
      }
    },
    { kind, images, regions, edges, connectable },
  );
}

// -- scenario harness, matching run.ts's own -------------------------------
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
  const dryRun = process.env.HOUR_ACTIONS !== undefined;
  console.log(
    `sheet-hour: actions=${ACTIONS}${dryRun ? ' (HOUR_ACTIONS set — dry run)' : ''}`,
  );

  const member = await signIn('member@example.test', 'password1234');
  const listed = await signIn('listed@example.test', 'password1234');

  const ownerGroups =
    await member.get<{ id: string; name: string }[]>('/groups');
  const labId = ownerGroups.json.find((g) => g.name === 'Lab')?.id;
  if (!labId)
    fail('setup: fixture group "Lab" not found — is the seed applied?');

  const boards = await member.get<{ id: string; name: string }[]>(
    `/groups/${labId}/boards`,
  );
  const fieldId = boards.json.find((b) => b.name === 'Field')?.id;
  if (!fieldId) fail('setup: fixture board "Field" not found');

  const sheets = await member.get<{ id: string; name: string }[]>(
    `/boards/${fieldId}/sheets`,
  );
  const firstPassId = sheets.json.find((s) => s.name === 'First pass')?.id;
  const facesId = sheets.json.find((s) => s.name === 'Faces')?.id;
  if (!firstPassId || !facesId)
    fail('setup: fixture sheets "First pass"/"Faces" not found');

  const firstPassSheet = await member.get<{
    images: { id: string; slot: number }[];
  }>(`/sheets/${firstPassId}`);
  const facesSheet = await listed.get<{
    images: { id: string; slot: number }[];
  }>(`/sheets/${facesId}`);
  const sharedSlots = new Set([6, 7, 8, 9, 10, 11]);
  const firstPassImages = firstPassSheet.json.images
    .filter((i) => sharedSlots.has(i.slot))
    .map((i) => i.id);
  const facesImages = facesSheet.json.images
    .filter((i) => sharedSlots.has(i.slot))
    .map((i) => i.id);
  if (firstPassImages.length < 6 || facesImages.length < 6) {
    fail(
      `setup: expected both sheets to hold images at slots 6..11 — First pass has [${firstPassImages.join(',')}], Faces has [${facesImages.join(',')}]`,
    );
  }
  console.log(
    `setup ok: labId=${labId} fieldId=${fieldId} firstPassId=${firstPassId} facesId=${facesId}`,
  );

  const browser: Browser = await chromium.launch();

  async function pageFor(
    session: Session,
  ): Promise<{ context: BrowserContext; page: Page }> {
    const context = await browser.newContext({
      viewport: { width: 1600, height: 1000 },
    });
    // Generic on purpose: the stub's cookie ("digsite.stub_session") and the
    // real server's ("better-auth.session_token") are both just "name=value"
    // off Set-Cookie — see session.ts's own header comment on why this file
    // uses plain fetch instead of Playwright's `request`.
    const eq = session.cookie.indexOf('=');
    const name = session.cookie.slice(0, eq);
    const value = session.cookie.slice(eq + 1);
    await context.addCookies([{ name, value, domain: 'localhost', path: '/' }]);
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

  const a = await pageFor(member);
  const b = await pageFor(listed);
  await a.page.goto(`${WEB}/s/${firstPassId}`);
  await waitForDigsite(a.page);
  await b.page.goto(`${WEB}/s/${facesId}`);
  await waitForDigsite(b.page);

  const workerA: Worker = {
    label: 'member/First pass',
    page: a.page,
    sheetId: firstPassId,
    images: firstPassImages,
  };
  const workerB: Worker = {
    label: 'listed/Faces',
    page: b.page,
    sheetId: facesId,
    images: facesImages,
  };
  // Reference kept so a future action set (e.g. targeting a specific
  // imageId by id lookup) has it on hand without re-querying the DOM.
  void ownImageElId;

  await scenario(1, `run ~${ACTIONS} actions across both sheets`, async () => {
    for (let i = 0; i < ACTIONS; i++) {
      const worker = Math.random() < 0.5 ? workerA : workerB;
      try {
        await doAction(worker);
      } catch {
        // an individual action failing to apply (nothing to draw on,
        // nothing foreign to copy, ...) is not a run failure — the next
        // action tries again.
      }
      await randomWait();
    }
    return `${ACTIONS} actions issued across ${workerA.label} and ${workerB.label}`;
  });

  console.log(`settling ${SETTLE_MS}ms (snapshot debounce + foreign poll)…`);
  await sleep(SETTLE_MS);

  // -- assertions -------------------------------------------------------------
  interface RegionRowLike {
    id: string;
    imageId: string;
    sheetName?: unknown;
  }
  interface EdgeRowLike {
    id: string;
    source: { imageId: string };
    target: { imageId: string };
    sheetName?: unknown;
  }
  const rowsA = await member.get<{
    regions: RegionRowLike[];
    edges: EdgeRowLike[];
  }>(`/sheets/${firstPassId}/rows`);
  const rowsB = await listed.get<{
    regions: RegionRowLike[];
    edges: EdgeRowLike[];
  }>(`/sheets/${facesId}/rows`);
  const foreignA = await member.get<{
    regions: RegionRowLike[];
    edges: EdgeRowLike[];
  }>(`/sheets/${firstPassId}/foreign`);
  const foreignB = await listed.get<{
    regions: RegionRowLike[];
    edges: EdgeRowLike[];
  }>(`/sheets/${facesId}/foreign`);

  await scenario(
    2,
    'sheet A (First pass) rows == project(getElements())',
    async () => {
      const els = await elementsOf(workerA.page);
      const projected = project(firstPassId, els as unknown as SceneElement[]);
      if (!sameRows(rowsA.json.regions, projected.regions)) {
        fail(
          `regions differ: server ${JSON.stringify(sortedById(rowsA.json.regions))} vs ` +
            `client ${JSON.stringify(sortedById(projected.regions))}`,
        );
      }
      if (!sameRows(rowsA.json.edges, projected.edges)) {
        fail(
          `edges differ: server ${JSON.stringify(sortedById(rowsA.json.edges))} vs ` +
            `client ${JSON.stringify(sortedById(projected.edges))}`,
        );
      }
      return `${rowsA.json.regions.length} regions, ${rowsA.json.edges.length} edges`;
    },
  );

  await scenario(
    3,
    'sheet B (Faces) rows == project(getElements())',
    async () => {
      const els = await elementsOf(workerB.page);
      const projected = project(facesId, els as unknown as SceneElement[]);
      if (!sameRows(rowsB.json.regions, projected.regions)) {
        fail(
          `regions differ: server ${JSON.stringify(sortedById(rowsB.json.regions))} vs ` +
            `client ${JSON.stringify(sortedById(projected.regions))}`,
        );
      }
      if (!sameRows(rowsB.json.edges, projected.edges)) {
        fail(
          `edges differ: server ${JSON.stringify(sortedById(rowsB.json.edges))} vs ` +
            `client ${JSON.stringify(sortedById(projected.edges))}`,
        );
      }
      return `${rowsB.json.regions.length} regions, ${rowsB.json.edges.length} edges`;
    },
  );

  await scenario(
    4,
    "sheet A's foreign == sheet B's rows filtered to A's images",
    async () => {
      const imagesA = new Set(workerA.images);
      const wantRegions = rowsB.json.regions.filter((r) =>
        imagesA.has(r.imageId),
      );
      const wantEdges = rowsB.json.edges.filter(
        (e) => imagesA.has(e.source.imageId) && imagesA.has(e.target.imageId),
      );
      if (!sameRows(stripSheetName(foreignA.json.regions), wantRegions)) {
        fail(
          `foreign regions differ: got ${JSON.stringify(sortedById(foreignA.json.regions))} ` +
            `want ${JSON.stringify(sortedById(wantRegions))}`,
        );
      }
      if (!sameRows(stripSheetName(foreignA.json.edges), wantEdges)) {
        fail(
          `foreign edges differ: got ${JSON.stringify(sortedById(foreignA.json.edges))} ` +
            `want ${JSON.stringify(sortedById(wantEdges))}`,
        );
      }
      return `${foreignA.json.regions.length} regions, ${foreignA.json.edges.length} edges`;
    },
  );

  await scenario(
    5,
    "sheet B's foreign == sheet A's rows filtered to B's images",
    async () => {
      const imagesB = new Set(workerB.images);
      const wantRegions = rowsA.json.regions.filter((r) =>
        imagesB.has(r.imageId),
      );
      const wantEdges = rowsA.json.edges.filter(
        (e) => imagesB.has(e.source.imageId) && imagesB.has(e.target.imageId),
      );
      if (!sameRows(stripSheetName(foreignB.json.regions), wantRegions)) {
        fail(
          `foreign regions differ: got ${JSON.stringify(sortedById(foreignB.json.regions))} ` +
            `want ${JSON.stringify(sortedById(wantRegions))}`,
        );
      }
      if (!sameRows(stripSheetName(foreignB.json.edges), wantEdges)) {
        fail(
          `foreign edges differ: got ${JSON.stringify(sortedById(foreignB.json.edges))} ` +
            `want ${JSON.stringify(sortedById(wantEdges))}`,
        );
      }
      return `${foreignB.json.regions.length} regions, ${foreignB.json.edges.length} edges`;
    },
  );

  await scenario(6, 'GET /stats foreignInScene == 0', async () => {
    const stats = await member.get<{ foreignInScene: number }>('/stats');
    if (stats.json.foreignInScene !== 0) {
      fail(`foreignInScene = ${stats.json.foreignInScene}, want 0`);
    }
    return '';
  });

  await scenario(
    7,
    'no element in either scene carries a foreign key',
    async () => {
      const elsA = await elementsOf(workerA.page);
      const elsB = await elementsOf(workerB.page);
      const badA = elsA.filter((e) => e.customData?.foreign !== undefined);
      const badB = elsB.filter((e) => e.customData?.foreign !== undefined);
      if (badA.length)
        fail(`sheet A has ${badA.length} element(s) with a foreign key`);
      if (badB.length)
        fail(`sheet B has ${badB.length} element(s) with a foreign key`);
      return '';
    },
  );

  await a.context.close();
  await b.context.close();
  await browser.close();

  const failed = results.filter((r) => !r.pass);
  console.log('');
  console.log(
    `${results.length - failed.length}/${results.length} scenarios passed`,
  );
  if (failed.length > 0)
    console.log(`FAILED: ${failed.map((r) => r.n).join(', ')}`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('sheet-hour crashed:', err);
  process.exit(1);
});
