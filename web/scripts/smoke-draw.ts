// A definition-of-done smoke script for phase 2 section 1/2/5/6
// (docs/phases/2-sheet.md): drawing, the inspector, dangling edges, and
// rename. Drives the running dev server (`bun run dev`) against the stub
// (`bun run stub`). Exits nonzero on any failed assertion.
//
// Coordinates: images in the seed grid sit at col*320, row*320 — row 0 is
// under our Toolbar (top:8,left:8), so every drawn shape here targets row 1
// or below. `sceneToClient` mirrors overlay/screen.ts#sceneToScreen using
// the live appState read off `window.__digsiteSheetDebug`, the same debug
// hook smoke.ts already relies on.
import { chromium } from 'playwright';

const WEB = process.env.WEB_ORIGIN ?? 'http://localhost:5180';
const SERVER = process.env.SERVER_ORIGIN ?? 'http://localhost:8800';
const SCREEN_DIR = new URL('../screenshots/', import.meta.url);

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${message}`);
}

function close(a: number, b: number, eps: number): boolean {
  return Math.abs(a - b) <= eps;
}

async function main() {
  const browser = await chromium.launch();
  // 1100 tall: row 2 of the seed grid (images 10/11, y=640..896) must stay
  // fully on screen — the delete-cascade case draws and clicks inside it.
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1100 },
  });

  await page.goto(WEB);
  await page.getByTestId('email').fill('owner@example.test');
  await page.getByTestId('password').fill('password1');
  await page.getByTestId('submit').click();
  await page.waitForURL(/\/groups$/);
  console.log('signed in');

  await page.goto(`${WEB}/s/s1`);
  await page.waitForFunction(() => typeof window.__digsite !== 'undefined');
  await page.waitForFunction(
    () => window.__digsite.getElements().length > 0,
    undefined,
    { timeout: 10_000 },
  );
  await page.waitForTimeout(1500); // let every image file decode and paint

  async function excalidrawBox() {
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

  async function sceneToClient(sx: number, sy: number) {
    const [box, vp] = await Promise.all([excalidrawBox(), viewport()]);
    return {
      x: box.x + (sx + vp.scrollX) * vp.zoom,
      y: box.y + (sy + vp.scrollY) * vp.zoom,
    };
  }

  async function imageRect(imageId: string) {
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
    return el as { x: number; y: number; width: number; height: number };
  }

  async function setTool(tool: string) {
    await page.evaluate(
      (t: string) => window.__digsite.setTool(t as never),
      tool,
    );
    await page.waitForTimeout(150);
  }

  // -- 1. region drawn by a real pointer drag --------------------------------
  await setTool('region');
  const img5 = await imageRect('img-5'); // row 1, col 0 — clear of the Toolbar
  const inset = 24;
  const start = await sceneToClient(img5.x + inset, img5.y + inset);
  const end = await sceneToClient(
    img5.x + img5.width - inset,
    img5.y + img5.height - inset,
  );
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move((start.x + end.x) / 2, (start.y + end.y) / 2, {
    steps: 6,
  });
  await page.mouse.move(end.x, end.y, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(200);

  const region5 = await page.evaluate(() =>
    window.__digsite.getElements().find(
      // biome-ignore lint/suspicious/noExplicitAny: crosses the browser boundary
      (e: any) =>
        e.customData?.kind === 'region' && e.customData.imageId === 'img-5',
    ),
  );
  assert(region5, 'no region drawn on img-5');
  const r5 = region5 as { x: number; y: number; width: number; height: number };
  const expectedFx = inset / img5.width;
  const expectedFw = (img5.width - 2 * inset) / img5.width;
  const gotFx = (r5.x - img5.x) / img5.width;
  const gotFw = r5.width / img5.width;
  assert(
    close(gotFx, expectedFx, 0.02) && close(gotFw, expectedFw, 0.02),
    `region fraction (fx=${gotFx.toFixed(3)}, fw=${gotFw.toFixed(3)}) does not match the drag (expected fx=${expectedFx.toFixed(3)}, fw=${expectedFw.toFixed(3)})`,
  );
  console.log(
    'PASS: region drawn by a real pointer drag lands inside its image at the expected fractions',
  );

  // -- label typed into the floating input on release -------------------------
  await page.waitForSelector('[data-testid="region-label-input"]');
  await page.keyboard.type('a find');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  const labelled = await page.evaluate(
    (id: string) =>
      window.__digsite
        .getElements()
        // biome-ignore lint/suspicious/noExplicitAny: crosses the browser boundary
        .find((e: any) => e.id === id),
    (region5 as { id: string }).id,
  );
  const labelledData = labelled as
    | { customData: { label: string } }
    | undefined;
  assert(
    labelledData?.customData.label === 'a find',
    `expected label "a find", got ${JSON.stringify(labelledData?.customData?.label)}`,
  );
  console.log('PASS: a typed label reached the region');

  // -- a 200-character label leaves the region's rect unchanged, live --------
  const rectBefore = { x: r5.x, y: r5.y, width: r5.width, height: r5.height };
  await page.evaluate(
    (id: string) => window.__digsite.setProperty(id, 'label', 'x'.repeat(200)),
    (region5 as { id: string }).id,
  );
  await page.waitForTimeout(150);
  const afterLongLabel = await page.evaluate(
    (id: string) =>
      window.__digsite
        .getElements()
        // biome-ignore lint/suspicious/noExplicitAny: crosses the browser boundary
        .find((e: any) => e.id === id),
    (region5 as { id: string }).id,
  );
  const a = afterLongLabel as {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  assert(
    close(a.x, rectBefore.x, 0.5) &&
      close(a.y, rectBefore.y, 0.5) &&
      close(a.width, rectBefore.width, 0.5) &&
      close(a.height, rectBefore.height, 0.5),
    `a 200-char label moved/resized the region: ${JSON.stringify(a)} vs ${JSON.stringify(rectBefore)}`,
  );
  console.log('PASS: a 200-character label leaves the region rect unchanged');

  await page.screenshot({
    path: new URL('sheet-draw.png', SCREEN_DIR).pathname,
  });
  console.log('screenshot: sheet-draw.png');

  // -- 2. edge connected by two real clicks -----------------------------------
  await setTool('edge');
  const img6 = await imageRect('img-6');
  const img7 = await imageRect('img-7');
  const c6 = await sceneToClient(
    img6.x + img6.width / 2,
    img6.y + img6.height / 2,
  );
  const c7 = await sceneToClient(
    img7.x + img7.width / 2,
    img7.y + img7.height / 2,
  );
  await page.mouse.click(c6.x, c6.y);
  await page.waitForSelector('[data-testid="edge-pending"]');
  await page.mouse.click(c7.x, c7.y);
  await page.waitForTimeout(200);

  const edge67 = await page.evaluate(() =>
    window.__digsite.getElements().find(
      // biome-ignore lint/suspicious/noExplicitAny: crosses the browser boundary
      (e: any) =>
        e.customData?.kind === 'edge' &&
        window.__digsite
          .getElements()
          // biome-ignore lint/suspicious/noExplicitAny: crosses the browser boundary
          .find((s: any) => s.id === e.startBinding?.elementId)?.customData
          ?.imageId === 'img-6',
    ),
  );
  assert(edge67, 'no edge created between img-6 and img-7');
  const e67 = edge67 as { id: string; endArrowhead: string | null };
  assert(
    e67.endArrowhead === 'arrow',
    `expected endArrowhead "arrow" (forward default), got ${e67.endArrowhead}`,
  );
  console.log('PASS: edge connected by two clicks, endArrowhead === "arrow"');

  // -- direction radio (the inspector's <select>) flips the arrowheads --------
  await setTool('select');
  await page.evaluate((id: string) => window.__digsite.select(id), e67.id);
  await page.waitForSelector('[data-testid="inspector-direction"]');
  await page.selectOption('[data-testid="inspector-direction"]', 'both');
  await page.waitForTimeout(150);
  const flipped = await page.evaluate(
    (id: string) =>
      window.__digsite
        .getElements()
        // biome-ignore lint/suspicious/noExplicitAny: crosses the browser boundary
        .find((e: any) => e.id === id),
    e67.id,
  );
  const f = flipped as {
    startArrowhead: string | null;
    endArrowhead: string | null;
  };
  assert(
    f.startArrowhead === 'arrow' && f.endArrowhead === 'arrow',
    `direction "both" did not flip both arrowheads: ${JSON.stringify(f)}`,
  );
  console.log('PASS: the direction control flips both arrowheads');

  // -- 3. deleting an image removes its region and edge -----------------------
  await setTool('region');
  const img10 = await imageRect('img-10');
  const img11 = await imageRect('img-11');
  const s10 = await sceneToClient(img10.x + inset, img10.y + inset);
  const e10 = await sceneToClient(
    img10.x + img10.width - inset,
    img10.y + img10.height - inset,
  );
  await page.mouse.move(s10.x, s10.y);
  await page.mouse.down();
  await page.mouse.move(e10.x, e10.y, { steps: 6 });
  await page.mouse.up();
  await page.waitForSelector('[data-testid="region-label-input"]');
  await page.keyboard.press('Escape'); // no label needed for this one
  await page.waitForTimeout(150);
  const region10 = await page.evaluate(() =>
    window.__digsite.getElements().find(
      // biome-ignore lint/suspicious/noExplicitAny: crosses the browser boundary
      (e: any) =>
        e.customData?.kind === 'region' && e.customData.imageId === 'img-10',
    ),
  );
  assert(region10, 'no region drawn on img-10 for the delete-cascade case');

  await setTool('edge');
  const c10 = await sceneToClient(
    img10.x + img10.width / 2,
    img10.y + img10.height / 2,
  );
  const c11 = await sceneToClient(
    img11.x + img11.width / 2,
    img11.y + img11.height / 2,
  );
  await page.mouse.click(c10.x, c10.y);
  await page.waitForSelector('[data-testid="edge-pending"]');
  await page.mouse.click(c11.x, c11.y);
  await page.waitForTimeout(150);
  const edgeCountBeforeDelete = await page.evaluate(
    () =>
      window.__digsite
        .getElements()
        .filter((e) => e.customData?.kind === 'edge').length,
  );

  // select the image (and, since it shares groupIds, the region drawn on it —
  // Excalidraw's own grouping) and delete via a real Delete keypress.
  await setTool('select');
  const clickImg10 = await sceneToClient(img10.x + 8, img10.y + 8); // a corner outside the region
  await page.mouse.click(clickImg10.x, clickImg10.y);
  await page.waitForTimeout(100);
  await page.keyboard.press('Delete');
  await page.waitForTimeout(250);

  const afterImageDelete = await page.evaluate(() => ({
    region: window.__digsite.getElements().find(
      // biome-ignore lint/suspicious/noExplicitAny: crosses the browser boundary
      (e: any) =>
        e.customData?.kind === 'region' && e.customData.imageId === 'img-10',
    ),
    edges: window.__digsite
      .getElements()
      .filter((e) => e.customData?.kind === 'edge').length,
  }));
  assert(
    !afterImageDelete.region,
    'the region on img-10 survived deleting img-10',
  );
  assert(
    afterImageDelete.edges === edgeCountBeforeDelete - 1,
    `expected one fewer edge after deleting img-10 (was ${edgeCountBeforeDelete}, now ${afterImageDelete.edges})`,
  );
  console.log('PASS: deleting an image removes its region and edge');

  // -- 4. deleting a region leaves a dangling edge -----------------------------
  // img-11 (col 1, row 2) — clear of the Toolbar (row 0) and clear of the
  // 280px Inspector sidebar eating into the canvas's right edge (columns 4+
  // sit past it at this viewport width; img-10's own test above stays at
  // col 0 for the same reason). img-11 survived the delete-cascade case
  // above (it was the edge's untouched far end), so it is still a plain
  // image here.
  await setTool('region');
  const s11d = await sceneToClient(img11.x + inset, img11.y + inset);
  const e11d = await sceneToClient(
    img11.x + img11.width - inset,
    img11.y + img11.height - inset,
  );
  await page.mouse.move(s11d.x, s11d.y);
  await page.mouse.down();
  await page.mouse.move(e11d.x, e11d.y, { steps: 6 });
  await page.mouse.up();
  await page.waitForSelector('[data-testid="region-label-input"]');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  const region11 = await page.evaluate(() =>
    window.__digsite.getElements().find(
      // biome-ignore lint/suspicious/noExplicitAny: crosses the browser boundary
      (e: any) =>
        e.customData?.kind === 'region' && e.customData.imageId === 'img-11',
    ),
  );
  assert(region11, 'no region drawn on img-11 for the dangling case');
  const regionId11 = (region11 as { id: string }).id;

  const connected = await page.evaluate(
    ([regionId, imageId]: [string, string]) => {
      const targetImage = window.__digsite
        .getElements()
        .find(
          (e) =>
            e.customData?.kind === 'image' &&
            (e.customData as { imageId?: string }).imageId === imageId,
        );
      if (!targetImage) return null;
      return window.__digsite.connect(regionId, targetImage.id);
    },
    [regionId11, 'img-6'] as [string, string],
  );
  assert(connected, 'no edge created from the region on img-11');

  // select ONLY the region — not the group — via the existing `select` hook
  // (image-graph's pattern: a hook drives the function, not the pixel; the
  // draw/connect steps above already covered the real-pointer path).
  await page.evaluate((id: string) => window.__digsite.select(id), regionId11);
  await page.waitForSelector('[data-testid="inspector-delete"]');
  await page.click('[data-testid="inspector-delete"]');
  await page.waitForTimeout(200);

  const dangling = await page.evaluate(() => window.__digsite.getDangling());
  assert(
    dangling.length >= 1,
    'getDangling() reported no dangling edges after the region delete',
  );
  assert(
    dangling.some((d) => d.id === connected),
    'the edge rebound from the deleted region is not in getDangling()',
  );
  console.log(
    `PASS: deleting a region leaves a dangling edge (${dangling.length} reported)`,
  );

  await page.screenshot({
    path: new URL('sheet-dangling.png', SCREEN_DIR).pathname,
  });
  console.log('screenshot: sheet-dangling.png');

  const removed = await page.evaluate(() => window.__digsite.removeDangling());
  assert(removed >= 1, 'removeDangling() removed nothing');
  const danglingAfter = await page.evaluate(() =>
    window.__digsite.getDangling(),
  );
  assert(
    danglingAfter.length === 0,
    `expected no dangling edges left, got ${danglingAfter.length}`,
  );
  console.log('PASS: removeDangling() clears the dangling list');

  // -- 5. rename round-trips ---------------------------------------------------
  await page.click('[data-testid="sheet-name"]');
  await page.fill('[data-testid="sheet-name-input"]', 'First pass (renamed)');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  const renamedOnPage = await page
    .locator('[data-testid="sheet-name"]')
    .innerText();
  assert(
    renamedOnPage === 'First pass (renamed)',
    `sheet name in the UI did not update, got "${renamedOnPage}"`,
  );
  const stubSheet = await page.request
    .get(`${SERVER}/sheets/s1`)
    .then((r) => r.json() as Promise<{ name: string }>);
  assert(
    stubSheet.name === 'First pass (renamed)',
    `stub's GET /sheets/s1 still has the old name: ${stubSheet.name}`,
  );
  console.log('PASS: rename round-trips through PATCH /sheets/:id');

  await browser.close();
  console.log('smoke-draw: all assertions passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
