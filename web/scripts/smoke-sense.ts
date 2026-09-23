// A definition-of-done smoke script for CONTEXT.md "Making sense": naming
// claims from a shared vocabulary, connecting in one gesture, evidence,
// confidence, reach and agreement. Drives the web dev server against the
// stub, like the other smoke scripts. Exits nonzero on any failed assertion.
//
// The stub seeds s1 (images 0..11) and s2 (images 6..17). s1 holds a region
// "find" on img-8 and a "resembles" edge; s2 holds "fragment" on img-9.
import { type Page, chromium } from 'playwright';

const WEB = process.env.WEB_ORIGIN ?? 'http://localhost:5180';
const SCREEN_DIR = new URL('../screenshots/', import.meta.url);

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${message}`);
}

type Box = { x: number; y: number; width: number; height: number };

async function sheetHelpers(page: Page) {
  async function canvasBox() {
    const box = await page.locator('.digsite-canvas').boundingBox();
    assert(box, 'no .digsite-canvas container on screen');
    return box;
  }
  async function viewport() {
    return page.evaluate(() => {
      // biome-ignore lint/suspicious/noExplicitAny: crosses the browser boundary
      const s: any = window.__digsiteSheetDebug?.getAppState();
      return { scrollX: s.scrollX, scrollY: s.scrollY, zoom: s.zoom.value };
    });
  }
  async function toClient(sx: number, sy: number) {
    const [box, vp] = await Promise.all([canvasBox(), viewport()]);
    return {
      x: box.x + (sx + vp.scrollX) * vp.zoom,
      y: box.y + (sy + vp.scrollY) * vp.zoom,
    };
  }
  async function imageEl(imageId: string) {
    const el = await page.evaluate(
      (id: string) =>
        window.__digsite.getElements().find(
          // biome-ignore lint/suspicious/noExplicitAny: crosses the browser boundary
          (e: any) =>
            e.customData?.kind === 'image' && e.customData.imageId === id,
        ),
      imageId,
    );
    assert(el, `no image element for ${imageId}`);
    return el as Box & { id: string };
  }
  async function centreOf(imageId: string) {
    const el = await imageEl(imageId);
    return toClient(el.x + el.width / 2, el.y + el.height / 2);
  }
  async function setTool(tool: string) {
    await page.evaluate(
      (t: string) => window.__digsite.setTool(t as never),
      tool,
    );
    await page.waitForTimeout(150);
  }
  /** The edge between two images' elements drawn on this sheet, if any. */
  async function edgeBetween(fromImage: string, toImage: string) {
    return page.evaluate(
      ([a, b]) => {
        const els = window.__digsite.getElements();
        const imageOf = (id: string): string | undefined => {
          // biome-ignore lint/suspicious/noExplicitAny: crosses the browser boundary
          const el: any = els.find((e: any) => e.id === id);
          return el?.customData?.imageId;
        };
        return (
          els.find(
            // biome-ignore lint/suspicious/noExplicitAny: crosses the browser boundary
            (e: any) =>
              e.customData?.kind === 'edge' &&
              imageOf(e.startBinding?.elementId) === a &&
              imageOf(e.endBinding?.elementId) === b,
            // biome-ignore lint/suspicious/noExplicitAny: crosses the browser boundary
          ) as any
        )?.customData;
      },
      [fromImage, toImage],
    );
  }
  /** Selects an image, then drags its connect handle onto another image. */
  async function connectByHandle(fromImage: string, toImage: string) {
    const from = await imageEl(fromImage);
    await setTool('select');
    await page.evaluate((id: string) => window.__digsite.select(id), from.id);
    const handle = page.getByTestId('connect-handle');
    await handle.waitFor();
    const hb = await handle.boundingBox();
    assert(hb, 'connect handle has no box');
    const to = await centreOf(toImage);
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.mouse.up();
    await page.getByTestId('relation-picker').waitFor();
  }
  return { imageEl, centreOf, toClient, setTool, edgeBetween, connectByHandle };
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1100 },
  });

  await page.goto(WEB);
  await page.getByTestId('email').fill('owner@example.test');
  await page.getByTestId('password').fill('password1');
  await page.getByTestId('submit').click();
  await page.waitForURL(/\/groups$/);

  await page.goto(`${WEB}/s/s1`);
  await page.waitForFunction(() => typeof window.__digsite !== 'undefined');
  await page.waitForFunction(() => window.__digsite.getElements().length > 0);
  await page.waitForTimeout(1500);
  const h = await sheetHelpers(page);

  // -- 1. connect in one gesture, named where it lands ---------------------
  await h.connectByHandle('img-5', 'img-6');
  const pickerInput = page.getByTestId('relation-picker-input');
  assert(
    await pickerInput.evaluate((el) => el === document.activeElement),
    'the relation picker did not take focus',
  );
  await page.waitForTimeout(250); // past the picker's entrance
  await page.screenshot({
    path: new URL('sense-connect.png', SCREEN_DIR).pathname,
  });
  await page.keyboard.type('same place');
  await page.keyboard.press('Enter');
  await page.getByTestId('relation-picker').waitFor({ state: 'detached' });
  const e56 = await h.edgeBetween('img-5', 'img-6');
  assert(
    e56?.relation === 'same place' && e56.direction === 'forward',
    `expected a forward "same place" edge, got ${JSON.stringify(e56)}`,
  );
  console.log('PASS: drag the handle, type, Enter: a named forward edge');

  // -- 2. the vocabulary suggests what this sheet already said -------------
  await h.connectByHandle('img-6', 'img-7');
  await page.keyboard.type('same');
  const option = page.locator('.sheet-relation-picker [role="option"]', {
    hasText: 'same place',
  });
  await option.waitFor();
  await page.waitForTimeout(250);
  await page.screenshot({
    path: new URL('sense-suggest.png', SCREEN_DIR).pathname,
  });
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.getByTestId('relation-picker').waitFor({ state: 'detached' });
  const e67 = await h.edgeBetween('img-6', 'img-7');
  assert(
    e67?.relation === 'same place',
    `a picked suggestion should name the edge, got ${JSON.stringify(e67)}`,
  );
  console.log(
    "PASS: a suggestion from this sheet's own terms names the next edge",
  );

  // -- 3. Escape keeps the connection, unnamed -----------------------------
  await h.connectByHandle('img-7', 'img-10');
  await page.keyboard.press('Escape');
  await page.getByTestId('relation-picker').waitFor({ state: 'detached' });
  const e710 = await h.edgeBetween('img-7', 'img-10');
  assert(e710 && e710.relation === '', 'Escape should keep the edge, unnamed');
  console.log('PASS: Escape keeps the new connection, unnamed');

  // -- 4. a label spelled differently is offered as the existing term ------
  const regionLabels = () =>
    page.evaluate(() =>
      window.__digsite
        .getElements()
        // biome-ignore lint/suspicious/noExplicitAny: crosses the browser boundary
        .filter((e: any) => e.customData?.kind === 'region')
        // biome-ignore lint/suspicious/noExplicitAny: crosses the browser boundary
        .map((e: any) => e.customData.label as string),
    );
  const findsBefore = (await regionLabels()).filter((l) => l === 'find').length;
  await h.setTool('region');
  const img11 = await h.imageEl('img-11');
  const a = await h.toClient(img11.x + 30, img11.y + 30);
  const b = await h.toClient(img11.x + 140, img11.y + 140);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.mouse.up();
  await page.getByTestId('region-label-input').waitFor();
  await page.keyboard.type('Find');
  const same = page.locator('.sheet-label-input [role="option"]', {
    hasText: 'Same term',
  });
  await same.waitFor();
  await page.screenshot({
    path: new URL('sense-label.png', SCREEN_DIR).pathname,
  });
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  const labels = await regionLabels();
  assert(
    labels.filter((l) => l === 'find').length === findsBefore + 1 &&
      !labels.includes('Find'),
    `"Find" should resolve to the existing label "find", got ${JSON.stringify(labels)}`,
  );
  console.log(
    'PASS: "Find" is offered as the existing label "find" and takes it',
  );

  // -- 4b. the keyboard loop: Tab moves to the next image in reading order --
  // The last region went on img-11, s1's last image; Tab wraps to img-0.
  await page.keyboard.press('Tab');
  await page.waitForTimeout(250);
  const canvas = await page.locator('.digsite-canvas').boundingBox();
  assert(canvas, 'no canvas box');
  const c0 = await h.centreOf('img-0');
  const off = Math.hypot(
    c0.x - (canvas.x + canvas.width / 2),
    c0.y - (canvas.y + canvas.height / 2),
  );
  assert(
    off < 60,
    `Tab should centre img-0, it is ${Math.round(off)}px off centre`,
  );
  console.log('PASS: with the Region tool, Tab moves to the next image');
  await h.setTool('select');
  await page.evaluate(() => window.__digsite.zoomToFit());
  await page.waitForTimeout(200);

  // -- 5. a connection shows its evidence; confidence and note are saved ----
  const e56Id = await page.evaluate(() => {
    const els = window.__digsite.getElements();
    // biome-ignore lint/suspicious/noExplicitAny: crosses the browser boundary
    const img = (id: string): any =>
      els.find(
        // biome-ignore lint/suspicious/noExplicitAny: crosses the browser boundary
        (e: any) =>
          e.customData?.kind === 'image' && e.customData.imageId === id,
      );
    const [a5, a6] = [img('img-5'), img('img-6')];
    return els.find(
      // biome-ignore lint/suspicious/noExplicitAny: crosses the browser boundary
      (e: any) =>
        e.customData?.kind === 'edge' &&
        e.startBinding?.elementId === a5?.id &&
        e.endBinding?.elementId === a6?.id,
    )?.id;
  });
  assert(e56Id, 'no img-5 -> img-6 edge to inspect');
  await h.setTool('select');
  await page.evaluate((id: string) => window.__digsite.select(id), e56Id);
  await page.getByTestId('inspector-evidence').waitFor();
  const crops = await page
    .locator('[data-testid="inspector-evidence"] figure')
    .count();
  assert(crops === 2, `evidence should show both ends, showed ${crops}`);
  await page.getByTestId('inspector-confidence-likely').check();
  await page.getByTestId('inspector-note').fill('same chimney, same roofline');
  await page.waitForTimeout(150);
  const inspected = await h.edgeBetween('img-5', 'img-6');
  assert(
    inspected?.confidence === 'likely' &&
      inspected.note === 'same chimney, same roofline',
    `confidence and note should reach the edge, got ${JSON.stringify(inspected)}`,
  );
  await page.screenshot({
    path: new URL('sense-evidence.png', SCREEN_DIR).pathname,
  });
  console.log(
    'PASS: the inspector shows both ends and saves confidence and note',
  );

  // -- 6. another sheet names the same pair differently: shown, not hidden --
  // s2 also holds img-6 and img-7; say something else about them there.
  await page.goto(`${WEB}/s/s2`);
  await page.waitForFunction(() => typeof window.__digsite !== 'undefined');
  await page.waitForFunction(() => window.__digsite.getElements().length > 0);
  await page.waitForTimeout(1000);
  await page.evaluate(() => {
    const els = window.__digsite.getElements();
    // biome-ignore lint/suspicious/noExplicitAny: crosses the browser boundary
    const img = (id: string): any =>
      els.find(
        // biome-ignore lint/suspicious/noExplicitAny: crosses the browser boundary
        (e: any) =>
          e.customData?.kind === 'image' && e.customData.imageId === id,
      );
    window.__digsite.connect(
      img('img-6').id,
      img('img-7').id,
      'different place',
      'forward',
    );
  });
  await page.waitForTimeout(1200); // the room relays and the stub projects

  await page.goto(`${WEB}/s/s1`);
  await page.waitForFunction(() => typeof window.__digsite !== 'undefined');
  await page.waitForFunction(() => window.__digsite.getElements().length > 0);
  await page.waitForTimeout(1500);
  const e67Id = await page.evaluate(() => {
    const els = window.__digsite.getElements();
    // biome-ignore lint/suspicious/noExplicitAny: crosses the browser boundary
    const img = (id: string): any =>
      els.find(
        // biome-ignore lint/suspicious/noExplicitAny: crosses the browser boundary
        (e: any) =>
          e.customData?.kind === 'image' && e.customData.imageId === id,
      );
    return els.find(
      // biome-ignore lint/suspicious/noExplicitAny: crosses the browser boundary
      (e: any) =>
        e.customData?.kind === 'edge' &&
        e.customData.relation === 'same place' &&
        e.startBinding?.elementId === img('img-6')?.id,
    )?.id;
  });
  assert(e67Id, 'no "same place" edge from img-6 on s1');
  await page.evaluate((id: string) => window.__digsite.select(id), e67Id);
  const pair = page.getByTestId('inspector-pair');
  await pair.waitFor({ timeout: 10_000 });
  const disagree = page.locator(
    '[data-testid="inspector-pair"] [data-agreement="disagree"]',
    {
      hasText: 'Faces',
    },
  );
  await disagree.first().waitFor({ timeout: 10_000 });
  await page.screenshot({
    path: new URL('sense-disagree.png', SCREEN_DIR).pathname,
  });
  console.log(
    "PASS: another sheet's different relation on the same pair shows as a disagreement",
  );

  // -- 7. reach: a connection that leads off this sheet, and bringing it in --
  // s2 holds img-15; s1 does not. Connect img-7 -> img-15 on s2.
  await page.goto(`${WEB}/s/s2`);
  await page.waitForFunction(() => typeof window.__digsite !== 'undefined');
  await page.waitForFunction(() => window.__digsite.getElements().length > 0);
  await page.waitForTimeout(1000);
  await page.evaluate(() => {
    const els = window.__digsite.getElements();
    // biome-ignore lint/suspicious/noExplicitAny: crosses the browser boundary
    const img = (id: string): any =>
      els.find(
        // biome-ignore lint/suspicious/noExplicitAny: crosses the browser boundary
        (e: any) =>
          e.customData?.kind === 'image' && e.customData.imageId === id,
      );
    window.__digsite.connect(
      img('img-7').id,
      img('img-15').id,
      'derived from',
      'forward',
    );
  });
  await page.waitForTimeout(1200);

  await page.goto(`${WEB}/s/s1`);
  await page.waitForFunction(() => typeof window.__digsite !== 'undefined');
  await page.waitForFunction(() => window.__digsite.getElements().length > 0);
  const badge = page.getByTestId('reach-badge-img-7');
  await badge.waitFor({ timeout: 10_000 });
  await badge.click();
  const card = page.getByTestId('reach-card-img-15');
  await card.waitFor();
  assert(
    (await card.innerText()).includes('derived from'),
    'the reach card should name the relation that leads there',
  );
  await page.waitForTimeout(250);
  await page.screenshot({
    path: new URL('sense-reach.png', SCREEN_DIR).pathname,
  });
  await card.click();
  await page.waitForFunction(
    () =>
      window.__digsite
        .getElements()
        .some(
          (e) =>
            e.customData?.kind === 'image' && e.customData.imageId === 'img-15',
        ),
    undefined,
    { timeout: 10_000 },
  );
  console.log(
    'PASS: reach shows where img-7 leads, and "Bring here" adds img-15',
  );

  // -- 7b. the machine suggests, a person decides ---------------------------
  const imagesBefore = await page.evaluate(
    () =>
      window.__digsite
        .getElements()
        .filter((e) => !e.isDeleted && e.customData?.kind === 'image').length,
  );
  const firstImage = await page.evaluate(
    () =>
      window.__digsite
        .getElements()
        .find((e) => !e.isDeleted && e.customData?.kind === 'image')?.id ?? '',
  );
  await page.evaluate((id: string) => window.__digsite.select(id), firstImage);
  await page.getByTestId('looks-like').waitFor({ timeout: 10_000 });
  await page.getByTestId('looks-like-bring').first().click();
  await page
    .getByTestId('looks-like-connect')
    .first()
    .waitFor({ timeout: 10_000 });
  const imagesAfter = await page.evaluate(
    () =>
      window.__digsite
        .getElements()
        .filter((e) => !e.isDeleted && e.customData?.kind === 'image').length,
  );
  assert(imagesAfter === imagesBefore + 1, 'Bring here should add one picture');
  const edgesBefore = await page.evaluate(
    () =>
      window.__digsite
        .getElements()
        .filter(
          (e) =>
            !e.isDeleted &&
            e.customData?.kind === 'edge' &&
            e.customData.relation === 'resembles',
        ).length,
  );
  await page.getByTestId('looks-like-connect').first().click();
  await page.waitForFunction(
    (n: number) =>
      window.__digsite
        .getElements()
        .filter(
          (e) =>
            !e.isDeleted &&
            e.customData?.kind === 'edge' &&
            e.customData.relation === 'resembles',
        ).length ===
      n + 1,
    edgesBefore,
  );
  await page.screenshot({
    path: new URL('sense-looks-like.png', SCREEN_DIR).pathname,
  });
  console.log(
    'PASS: "Looks like" suggests; Bring here adds one, and only a click connects it',
  );

  // -- 7c. a new region is offered the board's own labels ------------------
  await h.setTool('region');
  const suggestFor = await h.imageEl('img-2');
  const from = await h.toClient(suggestFor.x + 20, suggestFor.y + 20);
  const to = await h.toClient(suggestFor.x + 70, suggestFor.y + 70);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 5 });
  await page.mouse.up();
  await page.getByTestId('label-suggestions').waitFor({ timeout: 5000 });
  const firstTerm = await page
    .getByTestId('label-suggestion')
    .first()
    .innerText();
  await page.getByTestId('label-suggestion').first().click();
  const filled = await page.getByTestId('region-label-input').inputValue();
  assert(
    filled === firstTerm,
    `a suggestion should fill the label box, and only fill it: "${filled}" vs "${firstTerm}"`,
  );
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    (term: string) =>
      window.__digsite
        .getElements()
        .some(
          (e) =>
            !e.isDeleted &&
            e.customData?.kind === 'region' &&
            e.customData.label === term &&
            e.customData.imageId === 'img-2',
        ),
    firstTerm,
  );
  await h.setTool('select');
  // Leave the board's counts as the later steps expect them.
  await page.evaluate((term: string) => {
    const made = window.__digsite
      .getElements()
      .find(
        (e) =>
          !e.isDeleted &&
          e.customData?.kind === 'region' &&
          e.customData.label === term &&
          e.customData.imageId === 'img-2',
      );
    if (made) {
      window.__digsite.select(made.id);
      window.__digsite.deleteSelected();
    }
  }, firstTerm);
  await page.waitForTimeout(3500); // the room's save, before the board reads
  console.log(
    "PASS: a new region is offered the board's own labels; a click fills the box, Enter keeps it",
  );

  // -- 8. the board's Terms index finds images, and a merge widens it ------
  // "find" is on img-8 (seed) and img-11 (step 4); "fragment" on img-9.
  await page.goto(`${WEB}/b/b1`);
  await page.getByTestId('board-terms').waitFor();
  const findTerm = page.getByTestId('board-term-find');
  await findTerm.waitFor({ timeout: 10_000 });
  await findTerm.click();
  const count = page.getByTestId('board-find-count');
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="board-find-count"]')
        ?.textContent?.startsWith('2 matches'),
    undefined,
    { timeout: 10_000 },
  );
  console.log('PASS: a label in the Terms index finds its images on the map');

  await page
    .getByRole('button', { name: 'Merge "fragment" into another label' })
    .click();
  await page.getByTestId('board-term-merge-input').fill('find');
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="board-find-count"]')
        ?.textContent?.startsWith('3 matches'),
    undefined,
    { timeout: 10_000 },
  );
  assert(
    (await count.innerText()).startsWith('3 matches'),
    'after merging "fragment" into "find", find should match 3 images',
  );
  await page.waitForTimeout(250);
  await page.screenshot({
    path: new URL('sense-terms.png', SCREEN_DIR).pathname,
  });
  console.log(
    'PASS: merging "fragment" into "find" widens the find to 3 images',
  );

  // -- 9. search by meaning, and "More like this" -------------------------
  await page.getByTestId('board-claim-chip').click();
  await page.getByTestId('board-find-mode-meaning').check();
  await page.getByTestId('board-find-query').fill('harbour at dusk');
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="board-find-count"]')
        ?.textContent?.includes('closest first'),
    undefined,
    { timeout: 10_000 },
  );
  assert(
    (await page.getByTestId('board-filter-key').count()) === 0,
    'property filters should step aside while searching by meaning',
  );
  assert(
    (await page.getByTestId('board-find-strip-item').count()) === 12,
    'the best twelve should show as pictures',
  );
  console.log(
    'PASS: Find by meaning answers with the best 24, the top 12 as pictures',
  );

  await page.evaluate(() =>
    (
      window as unknown as { __digsiteBoard: { select: (r: number) => void } }
    ).__digsiteBoard.select(0),
  );
  const moreLike = page.getByTestId('detail-more-like');
  await moreLike.waitFor({ timeout: 10_000 });
  await moreLike.click();
  await page.getByTestId('board-like-chip').waitFor();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="board-find-count"]')
        ?.textContent?.includes('closest'),
    undefined,
    { timeout: 10_000 },
  );
  await page.screenshot({
    path: new URL('sense-more-like.png', SCREEN_DIR).pathname,
  });
  console.log('PASS: "More like this" on an image finds the pictures like it');

  await page.evaluate(() =>
    (
      window as unknown as { __digsiteBoard: { select: (r: number) => void } }
    ).__digsiteBoard.select(1),
  );
  await page.getByTestId('board-tray-compare').click();
  await page.getByTestId('compare').waitFor();
  await page.keyboard.press('Escape');
  await page.getByTestId('compare').waitFor({ state: 'detached' });
  console.log('PASS: two selected pictures open side by side from the tray');

  // Copies: a near-duplicate is suggested, checked side by side, never merged.
  await page.evaluate(() =>
    (
      window as unknown as { __digsiteBoard: { clear: () => void } }
    ).__digsiteBoard.clear(),
  );
  await page.evaluate(() =>
    (
      window as unknown as { __digsiteBoard: { select: (r: number) => void } }
    ).__digsiteBoard.select(1),
  );
  await page.getByTestId('copies').waitFor({ timeout: 10_000 });
  await page.getByTestId('copies-compare').first().click();
  await page.getByTestId('compare').waitFor();
  await page.keyboard.press('Escape');
  await page.getByTestId('compare').waitFor({ state: 'detached' });
  await page.getByTestId('copies-select').click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll('[data-testid="selection-item"]').length === 2,
  );
  console.log(
    'PASS: a copy is suggested, compared, and selected with its original',
  );

  await browser.close();
  console.log('smoke-sense: all assertions passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
