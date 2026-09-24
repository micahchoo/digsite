// The "making sense" claims, walked the way a person meets them: the real
// server, the real web app, two people on two sheets of one board, the
// mouse and keyboard for every step a person would take. Each numbered
// section is one claim; it asserts what the person would see and saves a
// screenshot. Seed (server/src/seed.ts): board "Field", sheets "First pass"
// (member, slots 0..11) and "Faces" (listed, slots 6..17).
import { mkdirSync, writeFileSync } from 'node:fs';
import type { EdgeRow, GetBoardResponse } from '@digsite/shared';
import { createCanvas } from '@napi-rs/canvas';
import { type BrowserContext, type Page, chromium } from 'playwright';
import { shortestPath } from '../../shared/src/sheet/path.ts';
import { edgePaths, midSegment } from '../../web/src/sheet/routing.ts';
import { SERVER, type Session, WEB, signIn } from './session.ts';

const SHOTS = new URL('../screenshots/sense/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${message}`);
}
const pass = (claim: string) => console.log(`PASS: ${claim}`);

/** What a person can see and reach: inside the viewport, and the element
 * itself is what sits on top at its own centre (not under the details
 * panel, not off the edge). Playwright acts on hidden things; people don't. */
async function seen(page: Page, testId: string): Promise<void> {
  const ok = await page
    .getByTestId(testId)
    .first()
    .evaluate((el) => {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) return false;
      const top = document.elementFromPoint(cx, cy);
      return !!top && (top === el || el.contains(top));
    });
  assert(ok, `"${testId}" is not where a person can see and reach it`);
}

type Box = { x: number; y: number; width: number; height: number };
type El = Box & {
  id: string;
  customData?: Record<string, unknown>;
  startBinding?: { elementId: string } | null;
  endBinding?: { elementId: string } | null;
};
type SheetWindow = Window & {
  __digsite: {
    getElements: () => El[];
    select: (id: string) => void;
    setTool: (t: string) => void;
    zoomToFit: (ids?: string[]) => void;
  };
  __digsiteSheetDebug?: {
    getAppState: () => {
      scrollX: number;
      scrollY: number;
      zoom: { value: number };
    };
  };
  __digsiteBoard?: { getLayerIds: () => string[] };
};

async function asUser(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  s: Session,
): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
  });
  await context.addCookies([
    {
      name: 'better-auth.session_token',
      value: s.cookie.split('=').slice(1).join('='),
      url: SERVER,
    },
  ]);
  return context;
}

/** Everything a sheet page needs, bound to the image ids of this seed. */
function sheetPage(page: Page, imageBySlot: Map<number, string>) {
  const id = (slot: number) => {
    const v = imageBySlot.get(slot);
    assert(v, `no image in slot ${slot}`);
    return v;
  };
  const elements = () =>
    page.evaluate(() =>
      (window as unknown as SheetWindow).__digsite.getElements(),
    );
  async function imageEl(slot: number): Promise<El> {
    const imageId = id(slot);
    const el = (await elements()).find(
      (e) => e.customData?.kind === 'image' && e.customData.imageId === imageId,
    );
    assert(el, `image slot ${slot} is not on this sheet`);
    return el;
  }
  async function toClient(sx: number, sy: number) {
    const box = await page.locator('.digsite-canvas').boundingBox();
    assert(box, 'no canvas on screen');
    const vp = await page.evaluate(() => {
      const s = (
        window as unknown as SheetWindow
      ).__digsiteSheetDebug?.getAppState();
      return s
        ? { scrollX: s.scrollX, scrollY: s.scrollY, zoom: s.zoom.value }
        : null;
    });
    assert(vp, 'no sheet debug hook');
    return {
      x: box.x + (sx + vp.scrollX) * vp.zoom,
      y: box.y + (sy + vp.scrollY) * vp.zoom,
    };
  }
  async function centre(slot: number) {
    const el = await imageEl(slot);
    return toClient(el.x + el.width / 2, el.y + el.height / 2);
  }
  async function open(sheetId: string) {
    await page.goto(`${WEB}/s/${sheetId}`);
    await page.waitForFunction(
      () =>
        ((window as unknown as SheetWindow).__digsite?.getElements().length ??
          0) > 0,
      undefined,
      { timeout: 20_000 },
    );
    await page.waitForTimeout(1500);
  }
  async function tool(name: string) {
    await page.keyboard.press('Escape');
    const key = { select: 'v', region: 'r', edge: 'e' }[name];
    assert(key, `no key for ${name}`);
    await page
      .locator('.digsite-canvas')
      .click({ position: { x: 5, y: 5 } })
      .catch(() => {});
    await page.keyboard.press(key);
    await page.waitForTimeout(150);
  }
  /** Selects an image, then drags its connect handle onto another. */
  async function connect(fromSlot: number, toSlot: number) {
    await tool('select');
    // Selected by id, not by a click: after the other suites, another
    // sheet's region can sit on the picture's centre, and the overlay
    // rightly takes that click (foreign-never-in-scene.md).
    const from = await imageEl(fromSlot);
    await page.evaluate(
      (id) => (window as unknown as SheetWindow).__digsite.select(id),
      from.id,
    );
    const handle = page.getByTestId('connect-handle');
    await handle.waitFor({ timeout: 5000 });
    await seen(page, 'connect-handle');
    const hb = await handle.boundingBox();
    assert(hb, 'the connect handle has no box');
    const b = await centre(toSlot);
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 10 });
    await page.mouse.up();
    try {
      await page.getByTestId('relation-picker').waitFor({ timeout: 5000 });
    } catch (err) {
      console.log(`no relation picker after dragging ${fromSlot} -> ${toSlot}`);
      throw err;
    }
  }
  /** Draws a region on an image with a real drag and waits for its label field. */
  async function region(slot: number, inset = 30) {
    await tool('region');
    const el = await imageEl(slot);
    const a = await toClient(el.x + inset, el.y + inset);
    const b = await toClient(el.x + el.width / 2, el.y + el.height / 2);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 6 });
    await page.mouse.up();
    await page.getByTestId('region-label-input').waitFor({ timeout: 5000 });
  }
  async function edgeBetween(fromSlot: number, toSlot: number) {
    const els = await elements();
    const imgOf = (elId?: string) => {
      const e = els.find((x) => x.id === elId);
      if (!e) return undefined;
      return (e.customData?.imageId as string | undefined) ?? undefined;
    };
    // The newest: a claim means the connection it just made, and after the
    // other suites the same two pictures may already be joined (the hour
    // suite connects at random). New elements are appended to the scene.
    return [...els]
      .reverse()
      .find(
        (e) =>
          e.customData?.kind === 'edge' &&
          imgOf(e.startBinding?.elementId) === id(fromSlot) &&
          imgOf(e.endBinding?.elementId) === id(toSlot),
      );
  }
  return {
    id,
    elements,
    imageEl,
    centre,
    toClient,
    open,
    tool,
    connect,
    region,
    edgeBetween,
  };
}

// -- 16. A map arranged by meaning -------------------------------------------
// Eight families of pictures, uploaded shuffled, so upload order mixes them
// and only an arrangement by what they show can put a picture next to its
// kind. The claim is relative (docs/roadmap.md item 6): a picture's best
// /similar match sits within two rows more often under meaning.asc than
// under uploaded_at.desc. It stays true whatever the embedding model is.
const FAMILIES = 8;
const PER_FAMILY = 24;
const NEAR = 32; // two rows of 16

/** A picture of family `f`: its hue and its shape, varied within the family. */
function paintFamily(
  ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>,
  f: number,
  i: number,
): void {
  const hue = f * (360 / FAMILIES);
  ctx.fillStyle = `hsl(${hue}, 70%, ${45 + (i % 4) * 5}%)`;
  ctx.fillRect(0, 0, 256, 256);
  ctx.fillStyle = `hsl(${(hue + 180) % 360}, 60%, 30%)`;
  const r = 40 + (i % 5) * 12;
  const x = 60 + ((i * 37) % 136);
  const y = 60 + ((i * 53) % 136);
  ctx.beginPath();
  if (f % 2 === 0) ctx.arc(x, y, r, 0, Math.PI * 2);
  else ctx.rect(x - r, y - r, r * 2, r * 2);
  ctx.fill();
}

/** Deterministic shuffle, so a failure reproduces. */
function shuffled<T>(xs: T[]): T[] {
  const out = [...xs];
  let seed = 7;
  for (let i = out.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    const j = seed % (i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

async function meaningClaim(
  member: Session,
  labId: string,
  page: Page,
): Promise<void> {
  const created = await member.post<{ id: string }>(`/groups/${labId}/boards`, {
    name: `Arranged ${Date.now()}`,
    open: true,
  });
  // The board says how many pictures wait for a place only while the
  // server computes embeddings (EMBEDDINGS=on).
  const probe = await member.get<GetBoardResponse>(
    `/boards/${created.json.id}`,
  );
  if (probe.json.meaningUnplaced === undefined) {
    console.log('SKIP: 16. arranged by meaning (EMBEDDINGS is not on)');
    return;
  }
  assert(created.status === 200, `create board: ${created.status}`);
  const boardId = created.json.id;
  // One canvas, encoded every use: the encode releases what was drawn.
  const canvas = createCanvas(256, 256);
  const ctx = canvas.getContext('2d');
  const order = shuffled(
    Array.from({ length: FAMILIES * PER_FAMILY }, (_, n) => n),
  );
  // A batch holds at most 100 files; the upload queue sends batches too.
  for (let start = 0; start < order.length; start += 48) {
    const form = new FormData();
    for (const n of order.slice(start, start + 48)) {
      const f = Math.floor(n / PER_FAMILY);
      paintFamily(ctx, f, n % PER_FAMILY);
      form.append(
        'files',
        new Blob([new Uint8Array(canvas.encodeSync('png'))], {
          type: 'image/png',
        }),
        `family-${f}-${n % PER_FAMILY}.png`,
      );
    }
    const up = await member.postForm(`/boards/${boardId}/images`, form);
    assert(up.status === 202, `upload: ${up.status}`);
  }

  const ranked = async (sort: string) =>
    (
      await member.get<{ images: { id: string }[] }>(
        `/boards/${boardId}/images?sort=${sort}&from=0&count=${FAMILIES * PER_FAMILY}`,
      )
    ).json.images.map((i) => i.id);

  // Every picture embedded: /similar answers 409 until then.
  const ids = await ranked('uploaded_at.desc');
  assert(ids.length === FAMILIES * PER_FAMILY, `uploaded ${ids.length}`);
  const best = new Map<string, string>();
  const deadline = Date.now() + 180_000;
  while (best.size < ids.length) {
    assert(Date.now() < deadline, `embedded ${best.size}/${ids.length}`);
    for (const id of ids) {
      if (best.has(id)) continue;
      const r = await member.get<{ matches: { imageId: string }[] }>(
        `/boards/${boardId}/similar?image=${id}&sort=uploaded_at.desc&limit=2`,
      );
      if (r.status !== 200) continue;
      const top = r.json.matches.find((m) => m.imageId !== id);
      if (top) best.set(id, top.imageId);
    }
    if (best.size < ids.length) await Bun.sleep(2000);
  }

  // The arrangement runs ~30 s after the last embedding lands. It is in
  // when no embedded picture waits for a place, and it is deterministic, so
  // the order cannot move after that.
  const board = () =>
    member.get<GetBoardResponse>(`/boards/${boardId}`).then((r) => r.json);
  for (;;) {
    const b = await board();
    assert(
      b.meaningUnplaced !== undefined,
      'the board does not say how many pictures wait for a place by meaning',
    );
    if (b.meaningUnplaced === 0) break;
    assert(
      Date.now() < deadline,
      `${b.meaningUnplaced} pictures never got a place by meaning`,
    );
    await Bun.sleep(3000);
  }
  assert(
    (await board()).sortableKeys.some((k) => k.key === 'meaning'),
    'the board does not offer meaning as a way to arrange it',
  );
  const meaning = await ranked('meaning.asc');

  const near = (order: string[]) => {
    const rank = new Map(order.map((id, i) => [id, i]));
    let n = 0;
    for (const [id, match] of best) {
      const a = rank.get(id);
      const b = rank.get(match);
      if (a !== undefined && b !== undefined && Math.abs(a - b) <= NEAR) n++;
    }
    return n;
  };
  const byMeaning = near(meaning);
  const byUpload = near(ids);
  assert(
    byMeaning > byUpload,
    `best matches within two rows: ${byMeaning} by meaning, ${byUpload} by upload`,
  );

  await page.goto(`${WEB}/b/${boardId}`);
  await page.getByTestId('sort-key').selectOption(JSON.stringify('meaning'));
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${SHOTS}16-arranged-by-meaning.png` });
  pass(
    `16. arranged by meaning, ${byMeaning}/${ids.length} pictures have their best match within two rows (by upload: ${byUpload})`,
  );
}

async function main(): Promise<void> {
  const member = await signIn('member@example.test', 'password1234');
  const listed = await signIn('listed@example.test', 'password1234');

  const groups = await member.get<{ id: string; name: string }[]>('/groups');
  const lab = groups.json.find((g) => g.name === 'Lab');
  assert(lab, 'no seeded group Lab');
  const boards = await member.get<{ id: string; name: string }[]>(
    `/groups/${lab.id}/boards`,
  );
  const field = boards.json.find((b) => b.name === 'Field');
  assert(field, 'no seeded board Field');
  const sheets = await member.get<{ id: string; name: string }[]>(
    `/boards/${field.id}/sheets`,
  );
  const firstPass = sheets.json.find((s) => s.name === 'First pass');
  const faces = sheets.json.find((s) => s.name === 'Faces');
  assert(firstPass && faces, 'seeded sheets missing');
  const imgs = await member.get<{ images: { id: string; slot: number }[] }>(
    `/boards/${field.id}/images?sort=name.asc&from=0&count=100`,
  );
  const bySlot = new Map(imgs.json.images.map((i) => [i.slot, i.id]));

  const browser = await chromium.launch();
  try {
    const m = await (await asUser(browser, member)).newPage();
    const l = await (await asUser(browser, listed)).newPage();
    const errors: string[] = [];
    for (const p of [m, l]) p.on('pageerror', (e) => errors.push(String(e)));
    const M = sheetPage(m, bySlot);
    const L = sheetPage(l, bySlot);
    await M.open(firstPass.id);

    // Images a person can see: the details panel floats over the right-hand
    // column. First pass shows 0 1 2 / 4 5 6 / 8 9 10 11; Faces shows
    // 6 7 8 / 10 11 12 / 14 15 16 17. Both hold 10 and 11.

    // -- 1. Connect in one gesture, named where it lands, from the vocabulary --
    await M.connect(4, 5);
    await seen(m, 'relation-picker');
    assert(
      await m
        .getByTestId('relation-picker-input')
        .evaluate((e) => e === document.activeElement),
      'the relation picker should take focus where the connection lands',
    );
    await m.keyboard.type('same place');
    await m.keyboard.press('Enter');
    await m.getByTestId('relation-picker').waitFor({ state: 'detached' });
    const e45 = await M.edgeBetween(4, 5);
    assert(
      e45?.customData?.relation === 'same place',
      'the new connection is not named "same place"',
    );
    await M.connect(10, 11);
    await m.keyboard.type('same');
    await m
      .locator('.sheet-relation-picker [role="option"]', {
        hasText: 'same place',
      })
      .waitFor();
    await m.screenshot({ path: `${SHOTS}1-suggest.png` });
    await m.keyboard.press('ArrowDown');
    await m.keyboard.press('Enter');
    await m.getByTestId('relation-picker').waitFor({ state: 'detached' });
    assert(
      (await M.edgeBetween(10, 11))?.customData?.relation === 'same place',
      'a picked suggestion did not name the edge',
    );
    await M.region(0);
    await m.keyboard.type('find');
    await m.keyboard.press('Enter');
    await M.region(1);
    await m.keyboard.type('Find');
    await m
      .locator('.sheet-label-input [role="option"]', { hasText: 'Same term' })
      .waitFor();
    await m.screenshot({ path: `${SHOTS}1-same-term.png` });
    await m.keyboard.press('ArrowDown');
    await m.keyboard.press('Enter');
    await m.waitForTimeout(200);
    const labels = (await M.elements())
      .filter((e) => e.customData?.kind === 'region')
      .map((e) => e.customData?.label);
    assert(
      labels.filter((x) => x === 'find').length === 2 &&
        !labels.includes('Find'),
      `"Find" should become the existing "find": ${JSON.stringify(labels)}`,
    );
    pass(
      '1. drag the handle, name it where it lands; suggestions; "Find" offered as "find"',
    );

    // -- 2. See why a connection holds; it survives a reload ---------------------
    await M.tool('select');
    await m.evaluate(
      (edgeId) => (window as unknown as SheetWindow).__digsite.select(edgeId),
      e45?.id ?? '',
    );
    await m.getByTestId('inspector-evidence').waitFor();
    const crops = await m
      .locator('[data-testid="inspector-evidence"] .claim-crop-image')
      .evaluateAll((els) =>
        els.map((e) => getComputedStyle(e).backgroundImage),
      );
    assert(
      crops.length === 2 && crops.every((c) => c.startsWith('url(')),
      `evidence should show both ends as pictures: ${JSON.stringify(crops)}`,
    );
    await m.getByTestId('inspector-confidence-likely').check();
    await m.getByTestId('inspector-note').fill('same chimney line');
    const stamps = await m.getByTestId('inspector-stamps').innerText();
    assert(
      /Added by member/.test(stamps),
      `the connection should say who made it: "${stamps}"`,
    );
    await m.waitForTimeout(3500); // the room's snapshot debounce, then the save
    await m.screenshot({ path: `${SHOTS}2-evidence.png` });
    await M.open(firstPass.id);
    const reloaded = await M.edgeBetween(4, 5);
    assert(
      reloaded?.customData?.confidence === 'likely' &&
        reloaded.customData.note === 'same chimney line',
      `confidence and note did not survive a reload: ${JSON.stringify(reloaded?.customData)}`,
    );
    pass(
      '2. both ends shown as crops; confidence and note saved on the real server and reloaded',
    );

    // -- 2b. After a reload, a line goes around the picture between its ends --
    // 8 -> 10 has image 9 between them. The line goes around 9, so a click
    // on 9 selects 9 and a click on the line, where the canvas drew it,
    // selects the connection. The line never covers 8 or 10.
    await M.connect(8, 10);
    await m.keyboard.type('resembles');
    await m.keyboard.press('Enter');
    await m.getByTestId('relation-picker').waitFor({ state: 'detached' });
    await m.waitForTimeout(3500);
    await M.open(firstPass.id);
    await M.tool('select');
    const e810 = await M.edgeBetween(8, 10);
    assert(e810, 'the 8 -> 10 connection did not survive the reload');
    // Fit, as a person would: the way around may pass under the last row.
    await m.evaluate(() =>
      (window as unknown as SheetWindow).__digsite.zoomToFit(),
    );
    await m.waitForTimeout(300);
    // The same function the canvas draws with, over the same elements.
    const route = edgePaths(await M.elements(), 1).get(e810.id) ?? [];
    assert(
      route.length > 2,
      `8 -> 10 should go around image 9, drawn as ${JSON.stringify(route)}`,
    );
    const [ra, rb] = midSegment(route);
    const onLine = await M.toClient((ra.x + rb.x) / 2, (ra.y + rb.y) / 2);
    await m.mouse.click(onLine.x, onLine.y);
    await m.waitForTimeout(250);
    await m.screenshot({ path: `${SHOTS}2b-line-around-image.png` });
    const lineHit = await m
      .locator('.claim-heading h2')
      .first()
      .innerText()
      .catch(() => '');
    assert(
      lineHit.startsWith('Connection'),
      `a click on the 8 -> 10 line where it was drawn selected "${lineHit}"`,
    );
    const img9 = await M.imageEl(9);
    const on9 = await M.toClient(
      img9.x + img9.width / 2,
      img9.y + img9.height / 2,
    );
    await m.mouse.click(on9.x, on9.y);
    await m.getByTestId('detail-panel').waitFor({ timeout: 5000 });
    const img8 = await M.imageEl(8);
    const end8 = await M.toClient(
      img8.x + img8.width * 0.75,
      img8.y + img8.height / 2,
    );
    await m.mouse.click(end8.x, end8.y);
    await m.waitForTimeout(250);
    assert(
      (await m.getByTestId('detail-panel').count()) === 1,
      'a click on image 8, where its own connection used to be drawn, did not select the image',
    );
    pass(
      '2b. after a reload, a line goes around the picture between its ends; the line, that picture and its ends are each clickable',
    );

    // -- 3. See disagreement: Faces names the same pair differently -------------
    await L.open(faces.id);
    await L.connect(10, 11);
    await l.keyboard.type('different place');
    await l.keyboard.press('Enter');
    await l.getByTestId('relation-picker').waitFor({ state: 'detached' });
    // Faces also connects 11 to 14, which First pass does not hold (claim 4).
    await L.connect(11, 14);
    await l.keyboard.type('derived from');
    await l.keyboard.press('Enter');
    await l.getByTestId('relation-picker').waitFor({ state: 'detached' });
    await l.waitForTimeout(3500); // Faces' snapshot is saved and projected

    await M.open(firstPass.id);
    const e1011 = await M.edgeBetween(10, 11);
    await M.tool('select');
    await m.evaluate(
      (edgeId) => (window as unknown as SheetWindow).__digsite.select(edgeId),
      e1011?.id ?? '',
    );
    // The seed's own claim, by its relation: when the full suite runs,
    // sheet-hour.ts has left random claims on Faces, and one on this pair
    // is a second disagreement from the same sheet.
    const disagree = m
      .locator(
        '[data-testid="inspector-pair"] .claim-pair-item[data-agreement="disagree"]',
        { hasText: 'Faces' },
      )
      .filter({ hasText: 'different place' });
    await disagree.waitFor({ timeout: 15_000 });
    await m.screenshot({ path: `${SHOTS}3-disagree.png` });
    await disagree.click();
    await m
      .locator('.claim-heading h2', { hasText: 'from Faces' })
      .waitFor({ timeout: 5000 });
    pass(
      "3. the other sheet's different relation is listed as a disagreement, and clicking it opens that claim",
    );

    // -- 4. Follow connections off the sheet, and bring one in ------------------
    // Exact against what the server holds now, so a suite that ran before
    // on the same database cannot make it wrong: every other sheet's claim
    // with one end on image 11 and the other off this sheet.
    const reachRows = await member.get<{
      edges: {
        near: 'source' | 'target';
        source: { imageId: string };
        target: { imageId: string };
      }[];
    }>(`/sheets/${firstPass.id}/reach`);
    const leaving = reachRows.json.edges.filter(
      (e) => (e.near === 'source' ? e.source : e.target).imageId === M.id(11),
    ).length;
    const badge = m.getByTestId(`reach-badge-${M.id(11)}`);
    await badge.waitFor({ timeout: 15_000 });
    assert(
      leaving >= 1 &&
        (await badge.innerText()).includes(`${leaving} elsewhere`),
      `badge reads "${await badge.innerText()}", the server has ${leaving}`,
    );
    await badge.click();
    const card = m.getByTestId(`reach-card-${M.id(14)}`);
    await card.waitFor();
    await m.waitForTimeout(200); // the fan's entrance
    await seen(m, `reach-card-${M.id(14)}`);
    assert(
      (await card.innerText()).includes('derived from'),
      'the reach card does not name the relation',
    );
    await m.screenshot({ path: `${SHOTS}4-reach.png` });
    await card.click();
    await m.waitForFunction(
      (imageId) =>
        (window as unknown as SheetWindow).__digsite
          .getElements()
          .some(
            (e) =>
              e.customData?.kind === 'image' &&
              e.customData.imageId === imageId,
          ),
      M.id(14),
      { timeout: 15_000 },
    );
    pass(
      '4. "1 elsewhere" on image 11 opens to "derived from", and Bring here adds image 14 live',
    );

    // -- 6. Annotate by keyboard: Region tool, drag, type, Enter, Tab -----------
    await M.open(firstPass.id);
    await M.region(4);
    await m.keyboard.type('find');
    await m.keyboard.press('Enter');
    await m.waitForTimeout(150);
    await m.keyboard.press('Tab');
    await m.waitForTimeout(300);
    const canvas = await m.locator('.digsite-canvas').boundingBox();
    assert(canvas, 'no canvas');
    const c5 = await M.centre(5);
    const off = Math.hypot(
      c5.x - (canvas.x + canvas.width / 2),
      c5.y - (canvas.y + canvas.height / 2),
    );
    await m.screenshot({ path: `${SHOTS}6-tab.png` });
    assert(
      off < 60,
      `Tab after labelling image 4 should centre image 5; it is ${Math.round(off)}px off`,
    );
    pass('6. Region tool: drag, type, Enter, Tab moves to the next image');

    // -- 6b. A tool says what it waits for, and how to leave it ------------------
    const modeBar = m.getByTestId('mode-bar');
    assert(
      (await modeBar.innerText()).includes('Drag across a picture'),
      `the Region tool's mode bar reads "${await modeBar.innerText()}"`,
    );
    await seen(m, 'mode-cancel');
    await m.keyboard.press('Escape');
    await modeBar.waitFor({ state: 'detached', timeout: 3000 });
    assert(
      (await m.getByTestId('tool-select').getAttribute('aria-pressed')) ===
        'true',
      'Esc in the Region tool did not return to Select',
    );
    await m.keyboard.press('e');
    assert(
      (await modeBar.innerText()).includes('starts'),
      `the Edge tool's mode bar reads "${await modeBar.innerText()}"`,
    );
    await m.getByTestId('mode-cancel').click();
    await modeBar.waitFor({ state: 'detached', timeout: 3000 });
    await m.keyboard.press('?');
    const help = m.getByTestId('shortcuts-panel');
    await help.waitFor({ timeout: 3000 });
    await seen(m, 'shortcuts-panel');
    assert(
      (await help.innerText()).includes('Mark a region on a picture'),
      'the keyboard panel does not list the Region key',
    );
    await m.screenshot({ path: `${SHOTS}6b-keys.png` });
    await m.keyboard.press('Escape');
    await help.waitFor({ state: 'detached', timeout: 3000 });
    pass(
      '6b. the mode bar names what Region and Edge wait for; Esc and Cancel leave; ? lists every key',
    );

    // -- 6c. Right-click: what is under the pointer, then the view, then delete --
    await m.evaluate(() =>
      (window as unknown as SheetWindow).__digsite.zoomToFit(),
    );
    await m.waitForTimeout(300);
    // Low and right on image 4: its "find" region covers the centre.
    const img4 = await M.imageEl(4);
    const on4 = await M.toClient(
      img4.x + img4.width * 0.85,
      img4.y + img4.height * 0.85,
    );
    await m.mouse.click(on4.x, on4.y, { button: 'right' });
    const sheetMenu = m.getByTestId('sheet-context-menu');
    await sheetMenu.waitFor({ timeout: 3000 });
    await seen(m, 'sheet-menu-mark-region');
    const menuText = await sheetMenu.innerText();
    assert(
      menuText.includes('Mark a region on it') &&
        menuText.includes('Remove picture from this sheet') &&
        menuText.indexOf('Fit every picture') <
          menuText.indexOf('Remove picture'),
      `the picture's menu reads ${JSON.stringify(menuText)}`,
    );
    await m.keyboard.press('Escape');
    await sheetMenu.waitFor({ state: 'detached', timeout: 3000 });
    const e45now = await M.edgeBetween(4, 5);
    assert(e45now, 'the 4 -> 5 connection is gone');
    const [ea, eb] = midSegment(
      edgePaths(await M.elements(), 1).get(e45now.id) ?? [],
    );
    const onEdge = await M.toClient((ea.x + eb.x) / 2, (ea.y + eb.y) / 2);
    await m.mouse.click(onEdge.x, onEdge.y, { button: 'right' });
    await sheetMenu.waitFor({ timeout: 3000 });
    assert(
      (await m
        .getByTestId('sheet-menu-sure-likely')
        .getAttribute('aria-checked')) === 'true',
      'the connection menu does not show "Likely" as how sure it is',
    );
    await m.screenshot({ path: `${SHOTS}6c-menu.png` });
    await m.getByTestId('sheet-menu-sure-confirmed').click();
    await m.waitForTimeout(200);
    assert(
      (await M.edgeBetween(4, 5))?.customData?.confidence === 'confirmed',
      'choosing "Confirmed" in the menu did not change the connection',
    );
    pass(
      '6c. right-click a picture or a connection: its own items first, removal last; how sure is set from the menu',
    );

    // -- 6c2. A mouse wheel zooms the sheet about the pointer, and only it ----
    {
      const box = await m.locator('.digsite-canvas canvas').boundingBox();
      assert(box, 'no sheet canvas');
      const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      const view = () =>
        m.evaluate((p) => {
          const s = (
            window as unknown as {
              __digsiteSheetDebug?: {
                getAppState: () => {
                  scrollX: number;
                  scrollY: number;
                  zoom: { value: number };
                } | null;
              };
            }
          ).__digsiteSheetDebug?.getAppState();
          const r = document
            .querySelector('.digsite-canvas canvas')
            ?.getBoundingClientRect();
          if (!s || !r) return null;
          const z = s.zoom.value;
          return {
            zoom: z,
            worldX: (p.x - r.left) / z - s.scrollX,
            worldY: (p.y - r.top) / z - s.scrollY,
            page: window.visualViewport?.scale ?? 1,
          };
        }, at);
      await m.mouse.move(at.x, at.y);
      const before = await view();
      await m.mouse.wheel(0, -300);
      await m.waitForTimeout(200);
      const after = await view();
      assert(
        before &&
          after &&
          after.zoom > before.zoom * 1.2 &&
          Math.abs(after.worldX - before.worldX) < 0.5 &&
          Math.abs(after.worldY - before.worldY) < 0.5 &&
          after.page === 1,
        `a wheel over the sheet should zoom it about the pointer: ${JSON.stringify({ before, after })}`,
      );
      await m.mouse.wheel(0, 300);
      await m.waitForTimeout(200);
      pass(
        '6c2. a mouse wheel zooms the sheet about the pointer, and not the page',
      );
    }

    // -- 6d. Names under pictures; a group reads as one; the cursor warns ------
    await m.keyboard.press('Escape');
    await m.evaluate(() =>
      (window as unknown as SheetWindow).__digsite.zoomToFit(),
    );
    await m.waitForTimeout(300);
    // A caption is canvas pixels, so read them: under a picture there must be
    // text-coloured pixels that the empty canvas background does not have.
    // The renderer leaves out a caption whose box would cover another
    // picture, and the other suites move pictures at random, so the claim
    // reads under the first picture with room below it (render.ts: 8 px
    // gap, 14 px tall).
    const screenBoxes = await Promise.all(
      Array.from({ length: 12 }, async (_, slot) => {
        const el = await M.imageEl(slot);
        const a = await M.toClient(el.x, el.y);
        const b = await M.toClient(el.x + el.width, el.y + el.height);
        return { slot, x0: a.x, y0: a.y, x1: b.x, y1: b.y };
      }),
    );
    const roomy = screenBoxes.find((p) =>
      screenBoxes.every(
        (o) =>
          o === p ||
          !(p.x0 < o.x1 && o.x0 < p.x1 && p.y1 + 8 < o.y1 && o.y0 < p.y1 + 22),
      ),
    );
    assert(roomy, 'no picture on the sheet has room for a caption below it');
    const pic = await M.imageEl(roomy.slot);
    const under = await M.toClient(pic.x, pic.y + pic.height);
    const right = await M.toClient(pic.x + pic.width, pic.y + pic.height);
    const captionInk = await m.evaluate(
      ({ x0, x1, y }) => {
        const canvas = document.querySelector<HTMLCanvasElement>(
          '.digsite-canvas canvas',
        );
        if (!canvas) return -1;
        const box = canvas.getBoundingClientRect();
        const ratio = canvas.width / box.width;
        const ctx = canvas.getContext('2d');
        if (!ctx) return -1;
        const data = ctx.getImageData(
          Math.round((x0 - box.left) * ratio),
          Math.round((y - box.top + 4) * ratio),
          Math.max(1, Math.round((x1 - x0) * ratio)),
          Math.round(12 * ratio),
        ).data;
        const [br, bg, bb] = [data[0], data[1], data[2]];
        let ink = 0;
        for (let i = 0; i < data.length; i += 4)
          if (
            Math.abs((data[i] ?? 0) - (br ?? 0)) +
              Math.abs((data[i + 1] ?? 0) - (bg ?? 0)) +
              Math.abs((data[i + 2] ?? 0) - (bb ?? 0)) >
            60
          )
            ink++;
        return ink;
      },
      { x0: under.x, x1: right.x, y: under.y },
    );
    assert(
      captionInk > 20,
      `no caption drawn under image ${roomy.slot} (${captionInk} px)`,
    );
    await m.evaluate(
      (ids) =>
        (window as unknown as SheetWindow).__digsite.select(ids[0] ?? ''),
      [(await M.imageEl(2)).id],
    );
    const shift = await M.centre(3);
    await m.keyboard.down('Shift');
    await m.mouse.click(shift.x, shift.y);
    await m.keyboard.up('Shift');
    await m.waitForTimeout(200);
    await m.screenshot({ path: `${SHOTS}6d-captions-group.png` });
    const on3 = await M.centre(3);
    await m.mouse.move(on3.x + 5, on3.y + 5);
    await m.waitForTimeout(100);
    const cursor = await m
      .locator('.digsite-canvas canvas')
      .evaluate((el) => (el as HTMLElement).style.cursor);
    assert(cursor === 'move', `over a picture the cursor is "${cursor}"`);
    pass(
      '6d. names under pictures; Shift-click groups two; the cursor says move',
    );

    // -- 6e. Check a claim: its two ends side by side, one zoom for both -----
    await m.keyboard.press('Escape');
    const e45c = await M.edgeBetween(4, 5);
    assert(e45c, 'the 4 -> 5 connection is gone');
    await m.evaluate(
      (id) => (window as unknown as SheetWindow).__digsite.select(id),
      e45c.id,
    );
    await m.getByTestId('inspector-compare').click();
    const compare = m.getByTestId('compare');
    await compare.waitFor({ timeout: 5000 });
    const widths = () =>
      m.evaluate(() =>
        ['a', 'b'].map((w) => {
          const img = document.querySelector<HTMLImageElement>(
            `[data-testid="compare-picture-${w}"]`,
          );
          return img && img.naturalWidth > 0
            ? img.getBoundingClientRect().width
            : 0;
        }),
      );
    await m.waitForFunction(
      () => {
        const imgs = Array.from(
          document.querySelectorAll<HTMLImageElement>('.compare-picture'),
        );
        return (
          imgs.length === 2 &&
          imgs.every(
            (img) => img.naturalWidth > 0 && img.style.visibility !== 'hidden',
          )
        );
      },
      undefined,
      { timeout: 10_000 },
    );
    const [a0 = 0, b0 = 0] = await widths();
    const paneA = await m.getByTestId('compare-pane-a').boundingBox();
    assert(paneA, 'no left pane');
    await m.mouse.move(paneA.x + paneA.width / 2, paneA.y + paneA.height / 2);
    await m.mouse.wheel(0, -600);
    await m.waitForTimeout(200);
    const [a1 = 0, b1 = 0] = await widths();
    assert(
      a0 > 0 && a1 > a0 * 1.5 && b1 > b0 * 1.5,
      `one wheel on the left should zoom both: ${a0}->${a1}, ${b0}->${b1}`,
    );
    await m.screenshot({ path: `${SHOTS}6e-compare.png` });
    await m.keyboard.press('3');
    await m.getByTestId('compare-difference').check();
    await m.screenshot({ path: `${SHOTS}6e-compare-difference.png` });
    await m.keyboard.press('2');
    await m.getByTestId('compare-divider').waitFor();
    await m.keyboard.press('Escape');
    await compare.waitFor({ state: 'detached', timeout: 3000 });
    pass(
      '6e. a connection opens side by side; one wheel zooms both; swipe and difference; Esc closes',
    );

    // -- 11. A region becomes a picture of its own, beside its parent --------
    const before = await M.elements();
    const findRegion = before.find(
      (e) =>
        e.customData?.kind === 'region' &&
        e.customData.label === 'find' &&
        e.customData.imageId === M.id(0),
    );
    assert(findRegion, 'the "find" region on image 0 is gone');
    await m.evaluate(
      (id) => (window as unknown as SheetWindow).__digsite.select(id),
      findRegion.id,
    );
    await m.getByTestId('inspector-extract').click();
    await m.waitForFunction(
      (regionId) =>
        (window as unknown as SheetWindow).__digsite
          .getElements()
          .some(
            (e) =>
              e.customData?.kind === 'edge' &&
              e.customData.relation === 'derived from' &&
              e.endBinding?.elementId === regionId,
          ),
      findRegion.id,
      { timeout: 30_000 },
    );
    const after = await M.elements();
    const made = after.find(
      (e) =>
        e.customData?.kind === 'image' && !before.some((b) => b.id === e.id),
    );
    assert(made, 'no new picture joined the sheet');
    const img0 = await M.imageEl(0);
    // Beside its parent, and on no other picture.
    const near =
      Math.abs(made.x + made.width / 2 - (img0.x + img0.width / 2)) +
      Math.abs(made.y + made.height / 2 - (img0.y + img0.height / 2));
    const overlapping = after.filter(
      (e) =>
        e.customData?.kind === 'image' &&
        e.id !== made.id &&
        e.x < made.x + made.width &&
        made.x < e.x + e.width &&
        e.y < made.y + made.height &&
        made.y < e.y + e.height,
    );
    assert(
      near < 500 && overlapping.length === 0,
      `the new picture should sit beside image 0 on nothing else: ${JSON.stringify({ made: [made.x, made.y], img0: [img0.x, img0.y], on: overlapping.map((e) => e.customData?.imageId) })}`,
    );
    await m.waitForTimeout(400);
    await m.screenshot({ path: `${SHOTS}11-extract.png` });
    pass(
      '11. "Make a picture of this region" adds the crop beside its parent, joined "derived from" to the region',
    );

    // -- 12. From a connection on a sheet, the web around it, then the board --
    const e45w = await M.edgeBetween(4, 5);
    assert(e45w, 'the 4 -> 5 connection is gone');
    await m.evaluate(
      (id) => (window as unknown as SheetWindow).__digsite.select(id),
      e45w.id,
    );
    await m.getByTestId('inspector-open-web').click();
    // The web is the board's (CONTEXT.md "Web"): the sheet sends the
    // question there, in the URL.
    await m.waitForURL(/\/b\/.*view=web.*roots=/, { timeout: 10_000 });
    const sheetWeb = m.getByTestId('web-view');
    await sheetWeb.waitFor({ timeout: 5000 });
    const node5 = m.locator(
      `[data-testid="web-view-node"][data-image-id="${M.id(5)}"]`,
    );
    await node5.waitFor({ timeout: 15_000 });
    await node5.click();
    await m.getByRole('button', { name: 'Show on the map' }).click();
    await m.getByTestId('web-view').waitFor({ state: 'detached' });
    const detailName = m.locator(
      '[data-testid="detail-panel"] .board-image-name',
    );
    await detailName.waitFor({ timeout: 15_000 });
    assert(
      (await detailName.innerText()) === 'image-5.png',
      `"Show on the map" should open image 5 there, not "${await detailName.innerText()}"`,
    );
    pass(
      '12. a connection on a sheet opens the board\'s web around both ends; "Show on the map" opens that picture there',
    );
    await M.open(firstPass.id);

    // -- 13. Show the work: a report that carries its own pictures ----------
    const [download] = await Promise.all([
      m.waitForEvent('download'),
      m.getByTestId('export-report').click(),
    ]);
    const reportPath = `${SHOTS}13-report.html`;
    await download.saveAs(reportPath);
    const report = await Bun.file(reportPath).text();
    const e45r = await M.edgeBetween(4, 5);
    assert(e45r, 'the 4 -> 5 connection is gone');
    assert(
      report.includes('First pass') &&
        report.includes('same place') &&
        report.includes('same chimney line') &&
        report.includes('Added') &&
        (report.match(/data:image\/jpeg;base64,/g)?.length ?? 0) >= 4 &&
        report.includes(`?claim=${e45r.id}`),
      'the report lacks the claim, its reason, its author or its pictures',
    );
    // Gathered by the server: the data travels with the document, each
    // picture is carried once and every crop is a view of it, and the
    // sheet stands as figure 1.
    const data = JSON.parse(
      report.match(
        /<script type="application\/json" id="digsite-report">(.*?)<\/script>/s,
      )?.[1] ?? 'null',
    ) as { format: string; claims: { elementId: string }[] } | null;
    assert(
      data?.format === 'digsite-report/1' &&
        data.claims.some((c) => c.elementId === e45r.id) &&
        report.includes('<use href="#pic-') &&
        report.includes('Figure 1.'),
      'the report carries no data, no picture views or no still of the sheet',
    );
    // The report's link to a claim opens the sheet on that claim.
    await m.goto(`${WEB}/s/${firstPass.id}?claim=${e45r.id}`);
    await m.getByTestId('inspector-evidence').waitFor({ timeout: 20_000 });
    const reportPage = await m.context().newPage();
    const reportErrors: string[] = [];
    reportPage.on('pageerror', (err) => reportErrors.push(err.message));
    await reportPage.goto(`file://${reportPath}`);
    await reportPage.screenshot({
      path: `${SHOTS}13-report.png`,
      fullPage: false,
    });
    // The file's viewer: the live sheet in figure 1, and each claim's
    // Compare and Show, working with no server behind them.
    await reportPage.waitForSelector('html[data-viewer="on"]', {
      timeout: 10_000,
    });
    await reportPage.locator('.rv-host canvas').first().waitFor();
    const firstCard = reportPage.locator('article.claim').first();
    await firstCard.getByTestId('report-compare').click();
    await reportPage.locator('.rv-host dialog.compare[open]').waitFor();
    await reportPage.screenshot({ path: `${SHOTS}13-report-compare.png` });
    await reportPage.keyboard.press('Escape');
    await reportPage
      .locator('.rv-host dialog.compare[open]')
      .waitFor({ state: 'detached' });
    await firstCard.getByTestId('report-show').click();
    await reportPage.waitForFunction(() =>
      document.querySelector('article.claim')?.classList.contains('is-focus'),
    );
    const status = await reportPage.getByTestId('report-status').innerText();
    assert(
      status.startsWith('Chosen: 1.') && reportErrors.length === 0,
      `the report's viewer did not show its first claim (${status}; ${reportErrors.join('; ')})`,
    );
    await reportPage.screenshot({ path: `${SHOTS}13-report-live.png` });
    // The Data section hands over the claims as Web Annotations, made in
    // the file from its own data.
    const [annotations] = await Promise.all([
      reportPage.waitForEvent('download'),
      reportPage.getByTestId('report-data-annotations.jsonld').click(),
    ]);
    const annotated = JSON.parse(
      await Bun.file((await annotations.path()) ?? '').text(),
    ) as { type: string; first: { items: { target: unknown }[] } };
    assert(
      annotated.type === 'AnnotationCollection' &&
        JSON.stringify(annotated.first.items).includes('xywh=percent:'),
      'the file gave no Web Annotations with region fragments',
    );
    await reportPage.close();
    pass(
      '13. "Export a report" downloads one file with every claim, its reasons, authors and pictures; in it the sheet is live, Compare opens, Show frames a claim; a claim link opens the sheet on it',
    );
    await M.open(firstPass.id);

    // -- 13c. Keep it; see what changed; a link a stranger reads ------------
    const [keptFile] = await Promise.all([
      m.waitForEvent('download'),
      m.getByTestId('keep-report').click(),
    ]);
    const keptPath = `${SHOTS}13c-kept.html`;
    await keptFile.saveAs(keptPath);
    const keptHtml = await Bun.file(keptPath).text();
    const keptId = keptHtml.match(
      /Report <code>([0-9a-f-]{36})<\/code>, kept by digsite/,
    )?.[1];
    assert(keptId, 'the kept report file does not name its id');
    await m.goto(`${WEB}/b/${field.id}`);
    const keptRow = m
      .getByTestId('report-list-item')
      .filter({ has: m.getByTestId(`report-download-${keptId}`) });
    await keptRow.waitFor({ timeout: 20_000 });
    await m.getByTestId(`report-changes-${keptId}`).click();
    const changesText = await keptRow.getByTestId('report-changes').innerText();
    assert(
      /Nothing has changed|the same/.test(changesText),
      `a report kept a moment ago reads: ${changesText}`,
    );
    const [evidence] = await Promise.all([
      m.waitForEvent('download'),
      m.getByTestId(`report-bundle-${keptId}`).click(),
    ]);
    const evidenceBytes = await Bun.file((await evidence.path()) ?? '').text();
    assert(
      evidence.suggestedFilename().endsWith('evidence.zip') &&
        evidenceBytes.includes('SHA256SUMS') &&
        evidenceBytes.includes('annotations.jsonld'),
      `the evidence download is ${evidence.suggestedFilename()}`,
    );
    await m.getByTestId(`report-publish-${keptId}`).click();
    const linkBox = m.getByTestId(`report-link-${keptId}`);
    await linkBox.waitFor({ timeout: 10_000 });
    const link = await linkBox.inputValue();
    assert(/\/r\/[A-Za-z0-9_-]{43}$/.test(link), `the link reads ${link}`);
    // A stranger: a new browser context, no cookies, no account.
    const strangerBrowser = m.context().browser();
    assert(strangerBrowser, 'no browser to open a stranger in');
    const strangerContext = await strangerBrowser.newContext();
    const stranger = await strangerContext.newPage();
    await stranger.goto(link);
    await stranger.getByTestId('published-report').waitFor({ timeout: 20_000 });
    const frame = stranger.frameLocator('.published-page iframe');
    await frame.locator('html[data-viewer="on"]').waitFor({ timeout: 15_000 });
    await frame.locator('.rv-host canvas').first().waitFor();
    const strangerClaims = await frame.locator('article.claim').count();
    await stranger.screenshot({ path: `${SHOTS}13c-published.png` });
    assert(
      strangerClaims >= 3,
      `a stranger reads ${strangerClaims} claims through the link`,
    );
    await m.getByTestId(`report-revoke-${keptId}`).click();
    await m
      .getByTestId(`report-publish-${keptId}`)
      .waitFor({ timeout: 10_000 });
    await stranger.reload();
    await stranger.getByTestId('published-gone').waitFor({ timeout: 15_000 });
    await strangerContext.close();
    pass(
      '13c. "Keep a report" keeps it with an id; the board lists it, says nothing changed and hands over its evidence zip; its link opens the live report for a stranger with no account, and stops when stopped',
    );
    await M.open(firstPass.id);

    // -- 13d. The report back in: a file becomes a sheet of its own claims --
    const keptData = JSON.parse(
      keptHtml.match(
        /<script type="application\/json" id="digsite-report">(.*?)<\/script>/s,
      )?.[1] ?? 'null',
    ) as { claims: { kind: string }[] };
    await m.goto(`${WEB}/b/${field.id}`);
    await m.getByTestId('board-actions-button').click();
    await m.getByTestId('board-menu-import-report').waitFor();
    await m.keyboard.press('Escape');
    await m.getByTestId('board-import-report-input').setInputFiles(keptPath);
    await m.waitForURL(
      (url) =>
        /\/s\/[0-9a-f-]{36}$/.test(url.pathname) &&
        !url.pathname.endsWith(firstPass.id),
      { timeout: 30_000 },
    );
    await m.waitForFunction(
      (want) => {
        const els =
          (
            window as unknown as {
              __digsite?: {
                getElements: () => {
                  isDeleted?: boolean;
                  customData?: { kind?: string };
                }[];
              };
            }
          ).__digsite?.getElements() ?? [];
        const claims = els.filter(
          (e) =>
            !e.isDeleted &&
            (e.customData?.kind === 'edge' || e.customData?.kind === 'region'),
        );
        return claims.length >= want;
      },
      keptData.claims.length,
      { timeout: 30_000 },
    );
    await m.screenshot({ path: `${SHOTS}13d-imported.png` });
    pass(
      `13d. the kept report's file imports as a new sheet: its pictures found by hash, where the report had them, all ${keptData.claims.length} claims this sheet's own`,
    );
    await M.open(firstPass.id);

    // -- 14. Arrow keys walk from picture to picture; a reader hears where ---
    await m.evaluate(
      (id) => (window as unknown as SheetWindow).__digsite.select(id),
      (await M.imageEl(4)).id,
    );
    await m.locator('.digsite-canvas canvas').focus();
    await m.keyboard.press('ArrowRight');
    const announcer = m.getByTestId('announcer');
    await m.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="announcer"]')
          ?.textContent?.startsWith('image-5.png selected'),
      undefined,
      { timeout: 5000 },
    );
    const heard = await announcer.innerText();
    assert(
      /image-5\.png selected\. \d+ connection/.test(heard),
      `after ArrowRight from image 4 a reader hears "${heard}"`,
    );
    await m.keyboard.press('Shift+ArrowRight');
    await m.waitForFunction(
      () =>
        document.querySelector('[data-testid="announcer"]')?.textContent ===
        '2 selected.',
      undefined,
      { timeout: 5000 },
    );
    await m.keyboard.press('Escape');
    pass(
      '14. arrow keys walk picture to picture and Shift adds; a screen reader hears what was chosen and its connections',
    );

    // -- 10. Discuss a claim: across two people and two sheets --------------
    // The member answers on their own 10 -> 11 "same place"; the listed user
    // reads it on Faces, where it shows as First pass's claim, and replies.
    const discussed = await M.edgeBetween(10, 11);
    assert(discussed, 'the 10 -> 11 connection is gone');
    await m.evaluate(
      (id) => (window as unknown as SheetWindow).__digsite.select(id),
      discussed.id,
    );
    await m.getByTestId('discussion').waitFor();
    await m
      .getByTestId('discussion-input')
      .fill('The chimney and the gutter line up.');
    await m.getByTestId('discussion-send').click();
    await m
      .getByTestId('discussion-reply')
      .filter({ hasText: 'The chimney and the gutter line up.' })
      .waitFor({ timeout: 5000 });
    const foreignRows = await listed.get<{
      edges: { id: string; relation: string; sheetName: string }[];
    }>(`/sheets/${faces.id}/foreign`);
    const theirs = foreignRows.json.edges.find(
      (e) => e.relation === 'same place' && e.sheetName === 'First pass',
    );
    assert(theirs, 'Faces does not see First pass\'s "same place"');
    await L.open(faces.id);
    await l.evaluate(
      (id) => (window as unknown as SheetWindow).__digsite.select(id),
      `edge-${theirs.id}`,
    );
    const onFaces = l
      .getByTestId('discussion-reply')
      .filter({ hasText: 'The chimney and the gutter line up.' });
    await onFaces.waitFor({ timeout: 10_000 });
    await l
      .getByTestId('discussion-input')
      .fill('The roofline is different; see the dormer.');
    await l.keyboard.press('Control+Enter');
    await l
      .getByTestId('discussion-reply')
      .filter({ hasText: 'see the dormer' })
      .waitFor({ timeout: 5000 });
    await l.screenshot({ path: `${SHOTS}10-discussion.png` });
    // The member sees the answer without reloading (polled).
    await m
      .getByTestId('discussion-reply')
      .filter({ hasText: 'see the dormer' })
      .waitFor({ timeout: 12_000 });
    pass(
      "10. a reply on a claim reaches the other sheet's reader, who answers in place; the first sees it live",
    );
    await m.keyboard.press('Escape');
    await m.waitForTimeout(3500); // let First pass save before the board reads it

    // -- 5. The board as an index ----------------------------------------------
    await m.goto(`${WEB}/b/${field.id}`);
    await m.waitForFunction(
      () => Boolean((window as unknown as SheetWindow).__digsiteBoard),
      undefined,
      { timeout: 20_000 },
    );
    const findTerm = m.getByTestId('board-term-find');
    await findTerm.waitFor({ timeout: 15_000 });
    await seen(m, 'board-term-find');
    // Counts against the server's vocabulary now, not the seed's.
    const vocab = await member.get<{
      labels: { term: string; count: number }[];
    }>(`/boards/${field.id}/vocabulary`);
    const findCount =
      vocab.json.labels.find((t) => t.term === 'find')?.count ?? 0;
    assert(
      findCount >= 3 &&
        (await findTerm.innerText()).includes(String(findCount)),
      `"find" should count ${findCount} regions: "${await findTerm.innerText()}"`,
    );
    await findTerm.click();
    await m.waitForFunction(
      () =>
        /^\d+ match/.test(
          document.querySelector('[data-testid="board-find-count"]')
            ?.textContent ?? '',
        ),
      undefined,
      { timeout: 10_000 },
    );
    const matchesOf = async () =>
      Number.parseInt(
        (await m.getByTestId('board-find-count').innerText()) || '0',
        10,
      );
    const findMatches = await matchesOf();
    assert(findMatches >= 3, `find by "find" matched ${findMatches} images`);
    const layers = await m.evaluate(
      () =>
        (window as unknown as SheetWindow).__digsiteBoard?.getLayerIds() ?? [],
    );
    assert(
      layers.includes('find-matches'),
      `the matches are not lit on the map: ${layers.join(',')}`,
    );
    await m.screenshot({ path: `${SHOTS}5-terms-find.png` });

    // Merge: Faces labels a region "fragment"; merge it into "find" on the board.
    await L.open(faces.id);
    await L.region(12);
    await l.keyboard.type('fragment');
    await l.keyboard.press('Enter');
    await l.waitForTimeout(3500);
    await m.reload();
    await m.getByTestId('board-term-fragment').waitFor({ timeout: 15_000 });
    await m.getByTestId('board-term-find').click();
    await m
      .getByRole('button', { name: 'Merge "fragment" into another label' })
      .click();
    await m.getByTestId('board-term-merge-input').fill('find');
    await m.keyboard.press('Enter');
    await m.waitForFunction(
      (before) =>
        Number.parseInt(
          document.querySelector('[data-testid="board-find-count"]')
            ?.textContent ?? '0',
          10,
        ) > before,
      findMatches,
      { timeout: 10_000 },
    );
    await m.screenshot({ path: `${SHOTS}5-merged.png` });
    const facesRegion = (await L.elements()).find(
      (e) =>
        e.customData?.kind === 'region' && e.customData.label === 'fragment',
    );
    assert(
      facesRegion,
      'the merge rewrote the label on the Faces sheet; it must not',
    );
    await m
      .getByRole('button', { name: 'Stop treating "fragment" as "find"' })
      .click();
    await m.waitForFunction(
      (before) =>
        Number.parseInt(
          document.querySelector('[data-testid="board-find-count"]')
            ?.textContent ?? '0',
          10,
        ) === before,
      findMatches,
      { timeout: 10_000 },
    );

    // Corner marks and Explore: zoom so cells are large, focus image 10.
    await m.getByTestId('board-zoom-pct').click();
    await m.waitForTimeout(800);
    const marks = await m.evaluate(
      () =>
        (window as unknown as SheetWindow).__digsiteBoard?.getLayerIds() ?? [],
    );
    assert(
      marks.includes('annotated-marks'),
      `no corner marks on annotated cells: ${marks.join(',')}`,
    );
    await m.evaluate(
      (ids) =>
        (
          window as unknown as {
            __digsiteBoard: { selectImages: (i: string[]) => void };
          }
        ).__digsiteBoard.selectImages(ids),
      [M.id(10)],
    );
    // Bring image 10 into view the way a person would: its tray thumbnail
    // flies the map there.
    await m.getByTestId('selection-item').first().click();
    const result = m.getByTestId('explore-result');
    await result.waitFor({ timeout: 10_000 });
    const summary = await result.innerText();
    assert(
      /Found \d+ images/.test(summary),
      `Explore did not answer on focus: "${summary}"`,
    );
    await m.waitForFunction(
      () =>
        (
          (window as unknown as SheetWindow).__digsiteBoard?.getLayerIds() ?? []
        ).includes('explore-lines'),
      undefined,
      { timeout: 10_000 },
    );
    await m.waitForTimeout(400);
    await m.screenshot({ path: `${SHOTS}5-explore.png` });
    pass(
      '5. Terms counts and lights up "find"; merge widens it without touching Faces; separate restores; corner marks; Explore answers on focus and draws lines',
    );

    // -- 8b. A click on the map selects even when the hand is not still ------
    // deck.gl's pan began at 1 px and its tap expired at 250 ms, so a click
    // that wobbled or was slow selected nothing: "works sometimes".
    {
      type BoardProbe = {
        __digsiteBoard: {
          clear: () => void;
          getSelection: () => number[];
          getCamera: () => { target: number[]; zoom: number } | null;
          setZoom: (z: number) => void;
          goToRank: (r: number) => void;
        };
      };
      // A clean map: the steps before leave Find and Explore open over it.
      await m.goto(`${WEB}/b/${field.id}`);
      await m.waitForFunction(
        () =>
          (window as unknown as BoardProbe).__digsiteBoard?.getCamera() != null,
      );
      await m.evaluate(() => {
        (window as unknown as BoardProbe).__digsiteBoard.clear();
        (window as unknown as BoardProbe).__digsiteBoard.goToRank(0);
      });
      await m.waitForTimeout(600);
      /** The press lands on the map itself, not a panel over it. */
      const onMap = (at: { x: number; y: number }) =>
        m.evaluate(
          ({ x, y }) => document.elementFromPoint(x, y)?.tagName ?? 'nothing',
          at,
        );
      const cellAt = (rank: number) =>
        m.evaluate((rank) => {
          const b = (window as unknown as BoardProbe).__digsiteBoard;
          const cam = b.getCamera();
          const box = document
            .querySelector('[data-testid="board-canvas"], canvas')
            ?.getBoundingClientRect();
          if (!cam || !box) return null;
          const s = 2 ** cam.zoom;
          const [tx = 0, ty = 0] = cam.target;
          return {
            x: box.left + box.width / 2 + ((rank % 16) * 128 + 64 - tx) * s,
            y:
              box.top +
              box.height / 2 +
              (Math.floor(rank / 16) * 128 + 64 - ty) * s,
          };
        }, rank);
      for (const [rank, hold, drift] of [
        // Past deck's old 250 ms tap and inside the 500 ms one, with room for
        // a slow runner: the hold is measured from the press, moves included.
        [0, 300, 3],
        [1, 60, 4],
        [2, 320, 0],
      ] as const) {
        const at = await cellAt(rank);
        assert(at, 'no board camera');
        const under = await onMap(at);
        assert(
          under === 'CANVAS',
          `cell ${rank} is under a ${under}, not the map`,
        );
        await m.mouse.move(at.x, at.y);
        const pressed = Date.now();
        await m.mouse.down();
        await m.mouse.move(at.x + drift, at.y - drift, { steps: 2 });
        await m.waitForTimeout(hold);
        await m.mouse.up();
        const held = Date.now() - pressed;
        // A pick asks the server which picture the cell holds.
        const picked = await m
          .waitForFunction(
            (rank) =>
              JSON.stringify(
                (window as unknown as BoardProbe).__digsiteBoard.getSelection(),
              ) === JSON.stringify([rank]),
            rank,
            { timeout: 15_000 },
          )
          .then(() => true)
          .catch(() => false);
        assert(
          picked,
          `a click on cell ${rank} (held ${held} ms, ${drift} px of wobble) selected ${JSON.stringify(await m.evaluate(() => (window as unknown as BoardProbe).__digsiteBoard.getSelection()))}`,
        );
      }
      // A real drag still pans, and selects nothing new.
      const before = await m.evaluate(
        () =>
          (window as unknown as BoardProbe).__digsiteBoard.getCamera()?.target,
      );
      // From a cell, so the press lands on the map and not a panel over it,
      // and up and left: the camera is at the map's top-left corner and
      // stops at the edge.
      const from = await cellAt(17);
      assert(from, 'no board camera');
      await m.mouse.move(from.x, from.y);
      await m.mouse.down();
      await m.mouse.move(from.x - 60, from.y - 30, { steps: 8 });
      await m.mouse.up();
      await m.waitForTimeout(400);
      const after = await m.evaluate(
        () =>
          (window as unknown as BoardProbe).__digsiteBoard.getCamera()?.target,
      );
      const kept = await m.evaluate(() =>
        (window as unknown as BoardProbe).__digsiteBoard.getSelection(),
      );
      assert(
        JSON.stringify(before) !== JSON.stringify(after) &&
          JSON.stringify(kept) === '[2]',
        `a drag should pan and keep the selection: ${JSON.stringify({ before, after, kept })}`,
      );
      pass(
        '8b. a map click selects with a few pixels of wobble or a slow press; after the map was moved by code, a drag still pans',
      );
    }

    // -- 9. How are two pictures connected, across sheets ----------------------
    // 8 -> 10 resembles (First pass), 10 -> 11 same place (First pass),
    // 11 -> 14 derived from (Faces): three steps, over both sheets.
    await m.evaluate(
      (ids) =>
        (
          window as unknown as {
            __digsiteBoard: { selectIds: (ids: string[]) => void };
          }
        ).__digsiteBoard.selectIds(ids),
      [M.id(8), M.id(14)],
    );
    await m.getByTestId('board-tray-path').click();
    const pathSummary = m.getByTestId('board-path-summary');
    await pathSummary.waitFor({ timeout: 15_000 });
    const links = await m.getByTestId('board-path-link').allInnerTexts();
    await m.waitForTimeout(400);
    await m.screenshot({ path: `${SHOTS}9-path.png` });
    // The chain the server's rows imply, through the same search: on the
    // seed alone it is resembles, same place, derived from.
    const [around8, around14] = await Promise.all(
      [M.id(8), M.id(14)].map(
        async (id) =>
          (
            await member.get<{ edges: EdgeRow[] }>(
              `/boards/${field.id}/neighbourhood?from=${id}&hops=3`,
            )
          ).json.edges,
      ),
    );
    const expected = shortestPath(
      [...(around8 ?? []), ...(around14 ?? [])],
      M.id(8),
      M.id(14),
    );
    assert(expected, 'the server holds no chain from 8 to 14');
    assert(
      (await pathSummary.innerText()).startsWith(
        expected.length === 1 ? 'Directly' : `${expected.length} steps`,
      ) &&
        links.length === expected.length &&
        expected.every((step, i) => links[i]?.includes(step.edge.relation)),
      `the chain from 8 to 14 reads ${JSON.stringify(links)}; the rows say ${JSON.stringify(expected.map((s) => s.edge.relation))}`,
    );
    assert(
      (
        await m.evaluate(() =>
          (window as unknown as SheetWindow).__digsiteBoard?.getLayerIds(),
        )
      )?.includes('path-lines'),
      'the chain is not drawn on the map',
    );
    pass(
      '9. two pictures: "How are they connected?" finds resembles, same place, derived from, across two sheets, and draws it',
    );

    // -- 9b. The web around both, as a full view you can walk ----------------
    await m.getByTestId('board-path-web').click();
    const web = m.getByTestId('web-view');
    await web.waitFor({ timeout: 5000 });
    await m.waitForFunction(
      () =>
        document.querySelectorAll('[data-testid="web-view-node"]').length >= 4,
      undefined,
      { timeout: 15_000 },
    );
    const nodes = await m.getByTestId('web-view-node').count();
    const edgesDrawn = await m.getByTestId('web-view-edge').count();
    assert(
      nodes >= 4 && edgesDrawn >= 3,
      `the web around 8 and 14 shows ${nodes} pictures and ${edgesDrawn} lines`,
    );
    await m.waitForTimeout(500);
    await m.screenshot({ path: `${SHOTS}9b-web.png` });
    // Walk: pick picture 10, then put it in the middle.
    await m
      .locator(`[data-testid="web-view-node"][data-image-id="${M.id(10)}"]`)
      .click();
    await m.getByTestId('web-view-walk').click();
    await m.waitForFunction(
      (id) =>
        document
          .querySelector(`[data-testid="web-view-node"][data-image-id="${id}"]`)
          ?.classList.contains('is-root'),
      M.id(10),
      { timeout: 10_000 },
    );
    await m.keyboard.press('Escape');
    await web.waitFor({ state: 'detached', timeout: 3000 });
    pass(
      '9b. the web around both opens as rings of pictures and lines; walking from picture 10 puts it in the middle',
    );

    // -- 9c. The web of one relation, from the board's Terms ------------------
    await m
      .getByTestId('board-terms')
      .getByRole('radio', { name: 'Relations' })
      .check();
    await m.getByTestId('board-term-web-same place').click();
    const relationWeb = m.getByTestId('web-view');
    await relationWeb.waitFor({ timeout: 10_000 });
    await m.waitForFunction(
      () =>
        document.querySelectorAll('[data-testid="web-view-node"]').length >= 4,
      undefined,
      { timeout: 20_000 },
    );
    const webTitle = await relationWeb.locator('h2').innerText();
    const relationsDrawn = await m
      .locator(
        '[data-testid="web-view-relations"] label, .web-view-relations label',
      )
      .allInnerTexts();
    assert(
      webTitle.includes('same place') &&
        relationsDrawn.some((r) => r.startsWith('same place')) &&
        !relationsDrawn.some((r) => r.startsWith('resembles')),
      `the web of "same place" reads "${webTitle}" with ${JSON.stringify(relationsDrawn)}`,
    );
    await m.screenshot({ path: `${SHOTS}9c-relation-web.png` });
    await m.keyboard.press('Escape');
    await relationWeb.waitFor({ state: 'detached', timeout: 3000 });
    pass(
      '9c. a relation in Terms opens the web of every picture it joins, and only that relation',
    );

    // -- 9d. Reports beyond one sheet: a relation, the path, the board ------
    type Gathered = {
      scope: { kind: string };
      sheets: { name: string }[];
      claims: { term: string; sheetId: string }[];
      path: string[] | null;
    };
    const downloaded = async (click: () => Promise<void>, name: string) => {
      const [file] = await Promise.all([m.waitForEvent('download'), click()]);
      const path = `${SHOTS}${name}.html`;
      await file.saveAs(path);
      const html = await Bun.file(path).text();
      const data = JSON.parse(
        html.match(
          /<script type="application\/json" id="digsite-report">(.*?)<\/script>/s,
        )?.[1] ?? 'null',
      ) as Gathered;
      return { path, html, data };
    };
    const byRelation = await downloaded(
      () => m.getByTestId('board-term-report-same place').click(),
      '9d-relation-report',
    );
    assert(
      byRelation.data.scope.kind === 'relation' &&
        byRelation.data.claims.length >= 2 &&
        byRelation.data.claims.every((c) => c.term === 'same place'),
      `the "same place" report holds ${JSON.stringify(byRelation.data.claims.map((c) => c.term))}`,
    );
    const byPath = await downloaded(
      () => m.getByTestId('board-path-report').click(),
      '9d-path-report',
    );
    assert(
      byPath.data.scope.kind === 'path' &&
        byPath.data.path?.length === expected.length + 1 &&
        byPath.html.includes(`in ${expected.length} step`),
      `the path report reads ${JSON.stringify(byPath.data.path)} for ${expected.length} steps`,
    );
    await m.getByTestId('board-actions-button').click();
    const byBoard = await downloaded(
      () => m.getByTestId('board-menu-report').click(),
      '9d-board-report',
    );
    const speaking = new Set(byBoard.data.claims.map((c) => c.sheetId));
    assert(
      byBoard.data.scope.kind === 'board' &&
        speaking.size >= 2 &&
        byBoard.data.sheets.some((s) => s.name === 'Faces') &&
        byBoard.html.includes('sheets disagree about'),
      `the board report speaks for ${speaking.size} sheets and marks no disagreement`,
    );
    // Its figure is the web, live, with no server behind it.
    const boardPage = await m.context().newPage();
    const boardErrors: string[] = [];
    boardPage.on('pageerror', (err) => boardErrors.push(err.message));
    await boardPage.goto(`file://${byBoard.path}`);
    await boardPage.waitForSelector('html[data-viewer="on"]', {
      timeout: 10_000,
    });
    await boardPage
      .locator('.rv-host [data-testid="web-view-node"]')
      .first()
      .waitFor();
    await boardPage
      .locator('article.claim')
      .first()
      .getByTestId('report-show')
      .click();
    const boardStatus = await boardPage
      .getByTestId('report-status')
      .innerText();
    await boardPage.screenshot({ path: `${SHOTS}9d-board-report.png` });
    await boardPage.close();
    assert(
      /chosen/i.test(boardStatus) && boardErrors.length === 0,
      `the board report's web did not light a claim (${boardStatus}; ${boardErrors.join('; ')})`,
    );
    pass(
      "9d. a relation, the path and the whole board each download as a report; the board's says where sheets disagree, and its web is live in the file",
    );

    // -- 9e. The web is a view of the board, and every web can be taken ------
    {
      const nodeCount = () => m.getByTestId('web-view-node').count();
      await m.getByTestId('board-view-web').click({ force: true });
      await m.waitForURL(/view=web/);
      await m.getByTestId('web-view-node').first().waitFor({ timeout: 20_000 });
      const title = await m.getByTestId('web-view-title').innerText();
      const whole = await nodeCount();
      assert(
        title === 'The whole web of this board' && whole >= 6,
        `the board's whole web reads "${title}" with ${whole} pictures`,
      );
      await m.screenshot({ path: `${SHOTS}9e-whole-web.png` });
      // Report on this: the claims the web shows, as a web-scoped report.
      const [webReport] = await Promise.all([
        m.waitForEvent('download'),
        m.getByTestId('web-report').click(),
      ]);
      const webHtml = await Bun.file((await webReport.path()) ?? '').text();
      const webData = JSON.parse(
        webHtml.match(
          /<script type="application\/json" id="digsite-report">(.*?)<\/script>/s,
        )?.[1] ?? 'null',
      ) as { scope: { kind: string }; claims: unknown[] };
      assert(
        webData.scope.kind === 'web' && webData.claims.length >= 4,
        `the web's report is ${webData.scope.kind} with ${webData.claims.length} claims`,
      );
      // Select on map: the web's pictures, on the map.
      await m.getByTestId('web-select-on-map').click();
      await m.getByTestId('web-view').waitFor({ state: 'detached' });
      await m.waitForFunction(
        (n) =>
          document.querySelectorAll('[data-testid="selection-item"]').length ===
          n,
        whole,
        { timeout: 10_000 },
      );
      // And back in, from the tray: the selection's web, one step out.
      await m.getByTestId('board-tray-web').click();
      await m.waitForURL(/view=web.*roots=.*hops=1/);
      await m.getByTestId('web-view-node').first().waitFor({ timeout: 20_000 });
      // Make a sheet: the web's pictures, where the web has them.
      await m.getByTestId('web-make-sheet').click();
      await m.waitForURL(/\/s\//, { timeout: 15_000 });
      await m.waitForFunction(
        (n) =>
          (
            (
              window as unknown as {
                __digsite?: {
                  getElements: () => {
                    isDeleted?: boolean;
                    customData?: { kind?: string };
                  }[];
                };
              }
            ).__digsite?.getElements() ?? []
          ).filter((e) => !e.isDeleted && e.customData?.kind === 'image')
            .length === n,
        whole,
        { timeout: 20_000 },
      );
      await m.screenshot({ path: `${SHOTS}9e-sheet-from-web.png` });
      pass(
        "9e. Web beside Map shows the board's whole web; it reports, selects on the map, opens again from the tray, and makes a sheet of what it shows",
      );
      await m.goto(`${WEB}/b/${field.id}`);
      await m.waitForFunction(
        () =>
          (window as unknown as { __digsiteBoard?: unknown }).__digsiteBoard,
      );
    }

    // -- 7. Zoom in on the board far enough to study a picture ------------------
    await m.evaluate(() =>
      (
        window as unknown as {
          __digsiteBoard: { goToRank: (rank: number) => void };
        }
      ).__digsiteBoard.goToRank(9),
    );
    const zoomIn = m.getByTestId('board-zoom-in');
    for (let i = 0; i < 20 && (await zoomIn.isEnabled()); i++) {
      await zoomIn.click();
      await m.waitForTimeout(60);
    }
    const pct = await m.getByTestId('board-zoom-pct').innerText();
    assert(pct === '800%', `the board stops zooming at ${pct}, not 800%`);
    await m.waitForFunction(
      () =>
        (
          (window as unknown as SheetWindow).__digsiteBoard?.getLayerIds() ?? []
        ).some((id) => id.startsWith('detail-')),
      undefined,
      { timeout: 15_000 },
    );
    await m.waitForTimeout(300);
    await m.screenshot({ path: `${SHOTS}7-detail.png` });
    pass(
      '7. the board zooms to 800%, and past the tiles each picture on screen draws from its own preview',
    );

    // -- 8. Import a folder the server can read -------------------------------
    // Only where the server allows folder imports (IMPORT_ROOTS).
    const root = process.env.IMPORT_ROOTS?.split(':')[0];
    if (root) {
      const folder = `${root}/walk-${Date.now()}`;
      mkdirSync(folder, { recursive: true });
      const { createCanvas } = await import('@napi-rs/canvas');
      for (let i = 0; i < 5; i++) {
        const c = createCanvas(64, 48);
        const ctx = c.getContext('2d');
        ctx.fillStyle = `hsl(${i * 70}, 60%, 50%)`;
        ctx.fillRect(0, 0, 64, 48);
        writeFileSync(`${folder}/import-${i}.png`, c.encodeSync('png'));
      }
      writeFileSync(`${folder}/notes.txt`, 'not a picture');
      const before = (
        await member.get<{ imageCount: number }>(`/boards/${field.id}`)
      ).json.imageCount;
      await m.getByTestId('board-actions-button').click();
      await m.getByTestId('board-menu-folder-import').click();
      await m.getByTestId('folder-import-path').fill(folder);
      await m.getByTestId('folder-import-start').click();
      const card = m.getByTestId('folder-import');
      await card.waitFor({ timeout: 10_000 });
      await m.waitForFunction(
        () =>
          document
            .querySelector('[data-testid="folder-import"]')
            ?.getAttribute('data-state') === 'done',
        undefined,
        { timeout: 60_000 },
      );
      const counts = await m.getByTestId('folder-import-counts').innerText();
      await m.screenshot({ path: `${SHOTS}8-folder-import.png` });
      // The server lists only picture files; notes.txt never counts.
      assert(
        counts.includes('Done: 5 of 5 imported'),
        `the import card reads "${counts}"`,
      );
      const after = (
        await member.get<{ imageCount: number }>(`/boards/${field.id}`)
      ).json.imageCount;
      assert(after === before + 5, `the board went from ${before} to ${after}`);
      pass(
        '8. a server folder imports from the Actions menu, and the card follows it to done',
      );
    } else {
      console.log('SKIP: 8. folder import (IMPORT_ROOTS is not set)');
    }

    // -- 15. A repeat visit asks the server for no tile ------------------------
    // Tiles carry the order build as ?v=, so a final tile is kept for a year;
    // a new build (here a property edit) moves the token and the map asks
    // again. Counted in the browser's own network log: from the server, not
    // the cache.
    // A new context: its cache is empty, so the first visit is a real one.
    const fresh = await (await asUser(browser, member)).newPage();
    const cdp = await fresh.context().newCDPSession(fresh);
    await cdp.send('Network.enable');
    let tilesFromServer = 0;

    cdp.on('Network.responseReceived', (e) => {
      const r = e.response as {
        url: string;
        fromDiskCache?: boolean;
        fromMemoryCache?: boolean;
      };
      if (r.url.includes('/tiles/') && !r.fromDiskCache && !r.fromMemoryCache)
        tilesFromServer++;
    });
    // Long enough for the map to load and ask, then until the count holds
    // still for 1.5 s: a zero that holds for a moment proves nothing.
    const tilesSettle = async () => {
      await fresh.waitForTimeout(4000);
      let last = -1;
      for (let i = 0; i < 20 && last !== tilesFromServer; i++) {
        last = tilesFromServer;
        await fresh.waitForTimeout(1500);
      }
    };
    await fresh.goto(`${WEB}/b/${field.id}`);
    await tilesSettle();
    const firstVisit = tilesFromServer;

    tilesFromServer = 0;
    await fresh.reload();
    await fresh.waitForFunction(
      () => (window as unknown as SheetWindow).__digsiteBoard !== undefined,
    );
    await tilesSettle();
    assert(
      firstVisit > 0 && tilesFromServer === 0,
      `a repeat visit asked the server for ${tilesFromServer} tiles (first visit ${firstVisit})`,
    );
    // A property edit makes a new build; the next answer in ranks names it,
    // and the map asks for its tiles again under the new token.
    const edited = await member.patch(`/images/${M.id(3)}`, {
      properties: { checked: 'yes' },
    });
    assert(
      edited.status === 200,
      `the property edit answered ${edited.status}`,
    );
    await fresh.getByTestId('board-find-toggle').click();
    await fresh.getByTestId('board-find-query').fill('image-3');
    await fresh.waitForFunction(
      () =>
        /^\d+ match/.test(
          document.querySelector('[data-testid="board-find-count"]')
            ?.textContent ?? '',
        ),
      undefined,
      { timeout: 10_000 },
    );
    await tilesSettle();
    assert(
      tilesFromServer > 0,
      'after a new order build the map should ask for its tiles again',
    );
    await fresh.close();
    pass(
      '15. a repeat visit asks the server for no tile; a new order build brings them back once',
    );

    // -- 17. Copy another sheet's connection, choosing what travels ---------
    // Before this claim, copying one called connect(imageId, imageId) while
    // image elements are keyed el-img-<imageId>, so nothing happened.
    await M.open(firstPass.id);
    const foreignEdge = await m.evaluate(() => {
      const d = (
        window as unknown as {
          __digsite: {
            getForeign: () => {
              id: string;
              kind: string;
              row: { relation: string; properties: Record<string, unknown> };
            }[];
          };
        }
      ).__digsite;
      return (
        d.getForeign().find((s) => s.kind === 'edge' && s.row.relation) ?? null
      );
    });
    assert(foreignEdge, 'First pass shows no connection from another sheet');
    const edgesBefore = (await M.elements()).filter(
      (e) => e.customData?.kind === 'edge',
    ).length;
    await m.evaluate(
      (id) => (window as unknown as SheetWindow).__digsite.select(id),
      foreignEdge.id,
    );
    await m.getByTestId('copy-foreign').click();
    await m.getByTestId('copy-chooser').waitFor();
    await m.screenshot({ path: `${SHOTS}17-copy-chooser.png` });
    await m.getByTestId('copy-foreign-confirm').click();
    await m.getByTestId('copy-chooser').waitFor({ state: 'detached' });
    const copied = (await M.elements()).filter(
      (e) =>
        e.customData?.kind === 'edge' &&
        e.customData.relation === foreignEdge.row.relation,
    );
    const edgesAfter = (await M.elements()).filter(
      (e) => e.customData?.kind === 'edge',
    ).length;
    assert(
      edgesAfter === edgesBefore + 1,
      `copying added ${edgesAfter - edgesBefore} connections, not one`,
    );
    const bound = copied.some(
      (e) =>
        e.startBinding?.elementId.startsWith('el-') &&
        e.endBinding?.elementId.startsWith('el-'),
    );
    assert(bound, 'the copy is not joined to this sheet’s pictures');
    pass(
      `17. a connection from another sheet copies here through the chooser ("${foreignEdge.row.relation}"), joined to this sheet's pictures`,
    );

    // -- 18. Copy pictures to another board; download them ------------------
    const copies = await member.post<{ id: string }>(
      `/groups/${lab.id}/boards`,
      {
        name: `Copies ${Date.now()}`,
        open: true,
      },
    );
    assert(
      copies.status === 200,
      `create a board to copy to: ${copies.status}`,
    );
    const three = [0, 1, 2].map((slot) => bySlot.get(slot) ?? '');
    await m.goto(`${WEB}/b/${field.id}`);
    await m.getByTestId('sort-key').waitFor();
    await m.evaluate(
      (ids) =>
        (
          window as unknown as {
            __digsiteBoard: { selectIds: (ids: string[]) => void };
          }
        ).__digsiteBoard.selectIds(ids),
      three,
    );
    const copyThrough = async () => {
      await m.getByTestId('board-actions-button').click();
      await m.getByTestId('board-menu-copy').click();
      await m.getByTestId('copy-to-board').waitFor();
      await m.getByTestId('copy-to-board-target').selectOption(copies.json.id);
      await m.getByTestId('copy-to-board-confirm').click();
      const outcome = m.getByTestId('copy-to-board-outcome');
      await outcome.waitFor({ timeout: 20_000 });
      const said = await outcome.innerText();
      await m.getByTestId('copy-to-board-confirm').click();
      await m.getByTestId('copy-to-board').waitFor({ state: 'detached' });
      return said;
    };
    const first = await copyThrough();
    assert(/Copied 3 pictures/.test(first), `the first copy said "${first}"`);
    const again = await copyThrough();
    assert(
      /Nothing new/.test(again) && /3 pictures were already there/.test(again),
      `copying the same three again said "${again}"`,
    );
    const landed = await member.get<{ imageCount: number }>(
      `/boards/${copies.json.id}`,
    );
    assert(
      landed.json.imageCount === 3,
      `the other board holds ${landed.json.imageCount} pictures, not 3`,
    );
    const downloading = m.waitForEvent('download', { timeout: 20_000 });
    await m.getByTestId('board-actions-button').click();
    await m.getByTestId('board-menu-download').click();
    const zip = await downloading;
    const zipPath = await zip.path();
    const size = zipPath
      ? (await Bun.file(zipPath).arrayBuffer()).byteLength
      : 0;
    assert(
      zip.suggestedFilename().endsWith('.zip') && size > 0,
      `the download was "${zip.suggestedFilename()}", ${size} bytes`,
    );
    pass(
      `18. three pictures copy to another board once, a second copy skips them, and they download as a zip (${size} bytes)`,
    );

    // -- 19. Two people on one board see what the other points at ----------
    await l.goto(`${WEB}/b/${field.id}`);
    await l.getByTestId('sort-key').waitFor();
    await m.goto(`${WEB}/b/${field.id}`);
    await m.getByTestId('sort-key').waitFor();
    await m.evaluate(
      (ids) =>
        (
          window as unknown as {
            __digsiteBoard: { selectIds: (ids: string[]) => void };
          }
        ).__digsiteBoard.selectIds(ids),
      [bySlot.get(4) ?? '', bySlot.get(5) ?? ''],
    );
    await l.waitForFunction(
      () =>
        (
          window as unknown as {
            __digsiteBoard?: { getLayerIds: () => string[] };
          }
        ).__digsiteBoard
          ?.getLayerIds()
          .includes('presence-outlines') ?? false,
      undefined,
      { timeout: 10_000 },
    );
    const here = await l.getByTestId('board-presence').innerText();
    assert(/member/i.test(here), `the other viewer is shown as "${here}"`);
    await l.screenshot({ path: `${SHOTS}19-presence.png` });
    // Leaving takes them off the other's board.
    await m.goto(`${WEB}/groups`);
    await l.getByTestId('board-presence').waitFor({
      state: 'detached',
      timeout: 10_000,
    });
    pass(
      '19. a picture one person selects is outlined, named, on the other person’s map; leaving takes it away',
    );

    await meaningClaim(member, lab.id, m);

    assert(errors.length === 0, `page errors: ${errors.join(' | ')}`);
    console.log('sense-claims: all claims passed');
  } catch (err) {
    // What the person would have been looking at when it failed.
    const pages = browser.contexts().flatMap((c) => c.pages());
    for (const [i, p] of pages.entries()) {
      await p.screenshot({ path: `${SHOTS}failure-${i}.png` }).catch(() => {});
      console.log(`failure page ${i}: ${p.url()}`);
    }
    throw err;
  } finally {
    await browser.close();
  }
}

await main();
