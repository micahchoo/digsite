// The "making sense" claims, walked the way a person meets them: the real
// server, the real web app, two people on two sheets of one board, the
// mouse and keyboard for every step a person would take. Each numbered
// section is one claim; it asserts what the person would see and saves a
// screenshot. Seed (server/src/seed.ts): board "Field", sheets "First pass"
// (member, slots 0..11) and "Faces" (listed, slots 6..17).
import { mkdirSync, writeFileSync } from 'node:fs';
import type { EdgeRow } from '@digsite/shared';
import { type BrowserContext, type Page, chromium } from 'playwright';
import { shortestPath } from '../../web/src/board/path.ts';
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
  /** Clicks an image to select it, then drags its connect handle onto another. */
  async function connect(fromSlot: number, toSlot: number) {
    await tool('select');
    const a = await centre(fromSlot);
    await page.mouse.click(a.x, a.y);
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
    return els.find(
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
    const disagree = m.locator(
      '[data-testid="inspector-pair"] .claim-pair-item[data-agreement="disagree"]',
      { hasText: 'Faces' },
    );
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

    // -- 6d. Names under pictures; a group reads as one; the cursor warns ------
    await m.keyboard.press('Escape');
    await m.evaluate(() =>
      (window as unknown as SheetWindow).__digsite.zoomToFit(),
    );
    await m.waitForTimeout(300);
    // A caption is canvas pixels, so read them: under image 2 there must be
    // text-coloured pixels that the empty canvas background does not have.
    const img2 = await M.imageEl(2);
    const under2 = await M.toClient(img2.x, img2.y + img2.height);
    const w2 = await M.toClient(img2.x + img2.width, img2.y + img2.height);
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
      { x0: under2.x, x1: w2.x, y: under2.y },
    );
    assert(
      captionInk > 20,
      `no caption drawn under image 2 (${captionInk} px)`,
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
    const sheetWeb = m.getByTestId('web-view');
    await sheetWeb.waitFor({ timeout: 5000 });
    const node5 = m.locator(
      `[data-testid="web-view-node"][data-image-id="${M.id(5)}"]`,
    );
    await node5.waitFor({ timeout: 15_000 });
    await node5.click();
    await m.getByRole('button', { name: 'Show on board' }).click();
    await m.waitForURL(/\/b\//, { timeout: 10_000 });
    const detailName = m.locator(
      '[data-testid="detail-panel"] .board-image-name',
    );
    await detailName.waitFor({ timeout: 15_000 });
    assert(
      (await detailName.innerText()) === 'image-5.png',
      `"Show on board" should open image 5 there, not "${await detailName.innerText()}"`,
    );
    pass(
      '12. a connection on a sheet opens the web around both ends; "Show on board" opens that picture on the board',
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
    // The report's link to a claim opens the sheet on that claim.
    await m.goto(`${WEB}/s/${firstPass.id}?claim=${e45r.id}`);
    await m.getByTestId('inspector-evidence').waitFor({ timeout: 20_000 });
    const reportPage = await m.context().newPage();
    await reportPage.goto(`file://${reportPath}`);
    await reportPage.screenshot({
      path: `${SHOTS}13-report.png`,
      fullPage: false,
    });
    await reportPage.close();
    pass(
      '13. "Export a report" downloads one file with every claim, its reasons, authors and pictures; a claim link opens the sheet on it',
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
