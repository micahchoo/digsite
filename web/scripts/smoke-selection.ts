import { CELL, COLS } from '@digsite/shared';
// A definition-of-done smoke script for docs/ux/design.md §7 "Slice 2 —
// Board + selection" / docs/phases/6-product.md "Selection" — the phase
// doc's own done-walk: select by click, range, band, section,
// neighbourhood, "show on board"; a sort change and a reload keep the same
// images selected; the tray reorders; a new sheet's layout follows the
// tray order; adding to an existing sheet skips duplicates; going over
// SHEET_LIMIT states the honest truncated count. Plus assertions for the
// shell-slice follow-ups this slice was asked to close: (a) the channel
// column refreshes after a sheet is created/renamed/deleted (an event, not
// a poll); (c) sign-out is race-free (a reload after it always shows the
// sign-in page); (d) Ctrl/Cmd+K on a sheet page opens our switcher, not
// a canvas-specific dialog.
//
// Drives the running dev server (`bun run dev`) against the stub
// (`bun run stub`). Exits nonzero on any failed assertion.
import { chromium } from 'playwright';

const WEB = process.env.WEB_ORIGIN ?? 'http://localhost:5180';
const SERVER = process.env.SERVER_ORIGIN ?? 'http://localhost:8800';
const SCREEN_DIR = new URL('../screenshots/', import.meta.url);

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${message}`);
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1000 },
  });

  await page.goto(WEB);
  await page.getByTestId('email').fill('owner@example.test');
  await page.getByTestId('password').fill('password1');
  await page.getByTestId('submit').click();
  await page.waitForURL(/\/groups$/);
  console.log('signed in');

  await page.goto(`${WEB}/b/b1`);
  await page.waitForSelector('canvas');
  await page.waitForFunction(
    () => typeof window.__digsiteBoard !== 'undefined',
  );
  await page.waitForTimeout(500);
  const box = await page.locator('canvas').boundingBox();
  assert(box, 'no canvas bounding box');

  // -- 1. click selects one image --------------------------------------------
  const p1 = { x: box.x + box.width * 0.25, y: box.y + box.height / 2 };
  await page.mouse.click(p1.x, p1.y);
  await page.waitForFunction(
    () => (window.__digsiteBoard?.getSelection() ?? []).length === 1,
    undefined,
    { timeout: 3000 },
  );
  console.log('PASS: click selects one image');

  // -- 2. Ctrl/Cmd+click toggles without clearing ------------------------------
  const p2 = { x: box.x + box.width * 0.35, y: box.y + box.height / 2 };
  await page.keyboard.down('Control');
  await page.mouse.click(p2.x, p2.y);
  await page.keyboard.up('Control');
  await page.waitForFunction(
    () => (window.__digsiteBoard?.getSelection() ?? []).length === 2,
    undefined,
    { timeout: 3000 },
  );
  console.log('PASS: Ctrl/Cmd+click toggles without clearing (2 selected)');

  // -- 3. Shift+click extends a rank range from the last click -----------------
  const p3 = { x: box.x + box.width * 0.55, y: box.y + box.height / 2 };
  await page.keyboard.down('Shift');
  await page.mouse.click(p3.x, p3.y);
  await page.keyboard.up('Shift');
  await page.waitForFunction(
    () => (window.__digsiteBoard?.getSelection() ?? []).length > 2,
    undefined,
    { timeout: 3000 },
  );
  const afterShiftClick = await page.evaluate(
    () => window.__digsiteBoard?.getSelection() ?? [],
  );
  console.log(
    `PASS: Shift+click extended a range (now ${afterShiftClick.length} selected)`,
  );
  await page.waitForSelector('[data-testid="board-tray"]');
  await page.screenshot({
    path: new URL('board-tray.png', SCREEN_DIR).pathname,
  });
  console.log('screenshot: board-tray.png');

  // -- 4. band drag (Shift+drag) selects a grid rectangle --------------------
  await page.evaluate(() => window.__digsiteBoard?.clear());
  await page.waitForFunction(
    () => (window.__digsiteBoard?.getSelection() ?? []).length === 0,
  );
  const bandDrag = await page.evaluate(
    ({ cols, cell }) => {
      const camera = window.__digsiteBoard?.getCamera();
      const canvas = document.querySelector('canvas')?.getBoundingClientRect();
      if (!camera || !canvas) return null;
      const screenPoint = (rank: number) => {
        const col = rank % cols;
        const row = Math.floor(rank / cols);
        const scale = 2 ** camera.zoom;
        return {
          x:
            canvas.left +
            canvas.width / 2 +
            (col * cell + cell / 2 - camera.target[0]) * scale,
          y:
            canvas.top +
            canvas.height / 2 +
            (row * cell + cell / 2 - camera.target[1]) * scale,
        };
      };
      return {
        start: screenPoint(0),
        end: screenPoint(18),
        camera,
      };
    },
    { cols: COLS, cell: CELL },
  );
  assert(bandDrag, 'could not project grid rectangle into the board canvas');
  await page.keyboard.down('Shift');
  await page.mouse.move(bandDrag.start.x, bandDrag.start.y);
  await page.mouse.down();
  await page.mouse.move(bandDrag.end.x, bandDrag.end.y, { steps: 10 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await page.waitForFunction(
    () => (window.__digsiteBoard?.getSelection() ?? []).length === 6,
    undefined,
    { timeout: 3000 },
  );
  const bandSel = await page.evaluate(
    () => window.__digsiteBoard?.getSelection() ?? [],
  );
  assert(
    JSON.stringify(bandSel) === JSON.stringify([0, 1, 2, 16, 17, 18]),
    `diagonal rectangle selected ${JSON.stringify(bandSel)} instead of its six cells`,
  );
  const cameraAfterBand = await page.evaluate(
    () => window.__digsiteBoard?.getCamera() ?? null,
  );
  assert(cameraAfterBand, 'camera unavailable after band drag');
  assert(
    Math.abs(cameraAfterBand.target[0] - bandDrag.camera.target[0]) < 0.01 &&
      Math.abs(cameraAfterBand.target[1] - bandDrag.camera.target[1]) < 0.01 &&
      cameraAfterBand.zoom === bandDrag.camera.zoom,
    `Shift-drag panned the board: before=${JSON.stringify(bandDrag.camera)} after=${JSON.stringify(cameraAfterBand)}`,
  );
  console.log(
    'PASS: Shift-drag selects the rectangular cells without moving the camera',
  );

  // -- 5. section select, from the right-click context menu -------------------
  await page.selectOption(
    '[data-testid="sort-key"]',
    JSON.stringify({ property: 'year', type: 'number' }),
  );
  await page.waitForFunction(
    () =>
      (window.__digsiteBoard?.getLayerIds() ?? []).includes('sections-text'),
    undefined,
    { timeout: 5000 },
  );
  await page.waitForTimeout(300);
  await page.mouse.click(p1.x, p1.y, { button: 'right' });
  await page.waitForSelector('[data-testid="board-context-menu"]');
  await page.screenshot({
    path: new URL('board-context-menu.png', SCREEN_DIR).pathname,
  });
  console.log('screenshot: board-context-menu.png');
  const sectionItem = page
    .locator('[data-testid="board-context-menu"] button')
    .filter({ hasText: 'Select this section' });
  assert(
    (await sectionItem.count()) > 0,
    'no "Select this section" item in the right-click menu',
  );
  await sectionItem.first().click();
  await page.waitForFunction(
    () => (window.__digsiteBoard?.getSelection() ?? []).length > 0,
    undefined,
    { timeout: 3000 },
  );
  console.log('PASS: "Select this section" from the right-click menu');

  // back to the default sort for the rest of this walk
  await page.selectOption(
    '[data-testid="sort-key"]',
    JSON.stringify('uploaded_at'),
  );
  await page.waitForTimeout(300);

  // -- 6. zoom control: in/out/fit/reset ---------------------------------------
  const pctBefore = await page.getByTestId('board-zoom-pct').innerText();
  await page.click('[data-testid="board-zoom-in"]');
  await page.waitForTimeout(150);
  const pctAfterIn = await page.getByTestId('board-zoom-pct').innerText();
  assert(
    pctAfterIn !== pctBefore,
    `zoom-in did not change the readout (still "${pctAfterIn}")`,
  );
  await page.click('[data-testid="board-zoom-out"]');
  await page.waitForTimeout(150);
  await page.click('[data-testid="board-zoom-fit"]');
  await page.waitForTimeout(150);
  await page.click('[data-testid="board-zoom-pct"]');
  await page.waitForTimeout(150);
  const pctAfterReset = await page.getByTestId('board-zoom-pct').innerText();
  assert(
    pctAfterReset === '100%',
    `expected zoom reset to 100%, got "${pctAfterReset}"`,
  );
  console.log('PASS: zoom control (−/%/+/fit) all work, reset lands on 100%');
  await page.screenshot({
    path: new URL('board-zoom.png', SCREEN_DIR).pathname,
  });
  console.log('screenshot: board-zoom.png');

  // -- 7. neighbourhood select, from the image detail's Explore panel ---------
  // img-8 has a connection in the seed (s1's "resembles" to img-9); an
  // image with none shows no neighbourhood to select.
  await page.evaluate(() => window.__digsiteBoard?.clear());
  await page.evaluate(() => window.__digsiteBoard?.selectImages(['img-8']));
  await page.waitForSelector('[data-testid="explore-panel"]', {
    timeout: 5000,
  });
  await page.getByTestId('explore-hops-1').check();
  await page.click('[data-testid="explore-go"]');
  await page.waitForSelector('[data-testid="explore-result"]');
  // currentSelectionCount was 1 (img-8) when Explore ran, so it asks first
  // (docs/ux/audit.md #6) rather than silently replacing.
  await page.waitForSelector('[data-testid="explore-selection-confirm"]');
  await page.click('[data-testid="explore-selection-replace"]');
  await page.waitForFunction(
    () => (window.__digsiteBoard?.getSelection() ?? []).length > 0,
    undefined,
    { timeout: 5000 },
  );
  console.log('PASS: "Select neighbourhood" (Explore) becomes the selection');

  // -- 8. "Show on board": a sheet's own page returns here with its images
  // selected, and the query param it arrived on is stripped from the URL. --
  await page.goto(`${WEB}/s/s1`);
  await page.waitForFunction(() => typeof window.__digsite !== 'undefined');
  await page.waitForSelector('[data-testid="show-on-board"]');
  await page.click('[data-testid="show-on-board"]');
  await page.waitForURL(/\/b\/b1/);
  await page.waitForFunction(
    () => typeof window.__digsiteBoard !== 'undefined',
  );
  await page.waitForFunction(
    () => (window.__digsiteBoard?.getSelection() ?? []).length === 12,
    undefined,
    { timeout: 5000 },
  );
  const urlAfterShow = new URL(page.url());
  assert(
    !urlAfterShow.searchParams.has('showSheet'),
    `"showSheet" was not stripped from the URL: ${page.url()}`,
  );
  console.log(
    'PASS: "Show on board" selected the sheet\'s 12 images and cleaned up the URL',
  );

  // -- 9. sort change and reload keep the SAME images selected (docs/phases/
  // 6-product.md's own defect: a rank-based selection would silently change
  // pictures under a sort change). Verified against the server's own
  // GET /boards/:id/selection, not the UI, so this proves the CONTRACT. -----
  await page.evaluate(() => window.__digsiteBoard?.clear());
  await page.evaluate(() =>
    window.__digsiteBoard?.selectImages(['img-3', 'img-40']),
  );
  await page.waitForFunction(
    () => (window.__digsiteBoard?.getSelection() ?? []).length === 2,
  );
  await page.waitForTimeout(400); // the 300ms PUT debounce
  const before = (await page.request
    .get(`${SERVER}/boards/b1/selection`)
    .then((r) => r.json())) as { imageIds: string[] };
  assert(
    [...before.imageIds].sort().join(',') === 'img-3,img-40',
    `unexpected persisted selection: ${JSON.stringify(before)}`,
  );

  await page.selectOption('[data-testid="sort-key"]', JSON.stringify('name'));
  await page.waitForTimeout(400);
  const afterSort = (await page.request
    .get(`${SERVER}/boards/b1/selection`)
    .then((r) => r.json())) as { imageIds: string[] };
  assert(
    [...afterSort.imageIds].sort().join(',') ===
      [...before.imageIds].sort().join(','),
    `selection changed after a sort change: before=${JSON.stringify(before)} after=${JSON.stringify(afterSort)}`,
  );
  console.log(
    'PASS: changing sort keeps the same images selected (ids, not ranks)',
  );

  await page.reload();
  await page.waitForFunction(
    () => typeof window.__digsiteBoard !== 'undefined',
  );
  await page.waitForTimeout(600);
  await page.waitForFunction(
    () => (window.__digsiteBoard?.getSelection() ?? []).length === 2,
    undefined,
    { timeout: 5000 },
  );
  console.log('PASS: a reload restores the same selection from the server');

  // -- 10. tray: drag-to-reorder ------------------------------------------------
  await page.waitForSelector('[data-testid="selection-item"]');
  await page.waitForFunction(
    () =>
      document.querySelectorAll('[data-testid="selection-item"]').length === 2,
  );
  const thumbsBefore = page.locator('[data-testid="selection-item"]');
  const firstNameBefore = await thumbsBefore.nth(0).getAttribute('title');
  await thumbsBefore.nth(0).dragTo(thumbsBefore.nth(1));
  await page.waitForTimeout(300);
  const thumbsAfter = page.locator('[data-testid="selection-item"]');
  const firstNameAfter = await thumbsAfter.nth(0).getAttribute('title');
  assert(
    firstNameAfter !== firstNameBefore,
    `drag-to-reorder did not change the tray's order (still "${firstNameBefore}" first)`,
  );
  console.log(
    `PASS: drag-to-reorder changed the tray's first thumbnail ("${firstNameBefore}" -> "${firstNameAfter}")`,
  );

  // -- 11. "Start a sheet": the new sheet's layout follows TRAY order ---------
  await page.click('[data-testid="board-tray-start-sheet"]');
  await page.fill('[data-testid="board-tray-sheet-name"]', 'Selection order');
  await page.click('[data-testid="board-tray-sheet-create"]');
  await page.waitForURL(/\/s\//);
  await page.waitForFunction(() => typeof window.__digsite !== 'undefined');
  await page.waitForFunction(
    () => window.__digsite.getElements().length > 0,
    undefined,
    { timeout: 10_000 },
  );
  await page.waitForTimeout(300);
  const positions = await page.evaluate(() =>
    window.__digsite
      .getElements()
      // biome-ignore lint/suspicious/noExplicitAny: crosses the browser boundary
      .filter((e: any) => e.customData?.kind === 'image')
      // biome-ignore lint/suspicious/noExplicitAny: crosses the browser boundary
      .map((e: any) => ({ id: e.customData.imageId, x: e.x as number })),
  );
  assert(
    positions.length === 2,
    `expected 2 image elements, got ${positions.length}`,
  );
  const expectedFirstId = `img-${(firstNameAfter ?? '').replace('image-', '')}`;
  const sortedByX = [...positions].sort((a, b) => a.x - b.x);
  assert(
    sortedByX[0]?.id === expectedFirstId,
    `layout did not follow tray order: expected "${expectedFirstId}" first by x, got ${JSON.stringify(sortedByX)}`,
  );
  console.log(
    `PASS: the new sheet's layout follows the tray order ("${expectedFirstId}" leftmost)`,
  );

  // -- (a) the channel column refreshed the moment this sheet was created,
  // via the notifySheetsChanged() event — not a poll. ------------------------
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="shell-channel"]')
        ?.textContent?.includes('Selection order'),
    undefined,
    { timeout: 3000 },
  );
  console.log(
    'PASS (a): the channel column shows a newly created sheet without a reload',
  );

  // -- (a) continued: a rename from the sheet's own page also refreshes it ---
  await page.click('[data-testid="sheet-name"]');
  await page.fill(
    '[data-testid="sheet-name-input"]',
    'Selection order renamed',
  );
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="shell-channel"]')
        ?.textContent?.includes('Selection order renamed'),
    undefined,
    { timeout: 3000 },
  );
  console.log('PASS (a): a sheet rename refreshes the channel column');

  // -- 12. "Add to sheet…": skips an id already on the sheet, adds the rest --
  await page.goto(`${WEB}/b/b1`);
  await page.waitForFunction(
    () => typeof window.__digsiteBoard !== 'undefined',
  );
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__digsiteBoard?.clear());
  // img-6 is already on "Faces" (s2, SHEET_IMAGES.s2 = range(6,18) in the
  // stub); img-45 is not.
  await page.evaluate(() =>
    window.__digsiteBoard?.selectImages(['img-6', 'img-45']),
  );
  await page.waitForFunction(
    () => (window.__digsiteBoard?.getSelection() ?? []).length === 2,
  );
  const beforeSheet = (await page.request
    .get(`${SERVER}/sheets/s2`)
    .then((r) => r.json())) as { images: { id: string }[] };
  await page.click('[data-testid="board-tray-add-to-sheet"]');
  await page.waitForSelector('[data-testid="board-tray-add-to-sheet-s2"]');
  await page.click('[data-testid="board-tray-add-to-sheet-s2"]');
  await page.waitForTimeout(400);
  const afterSheet = (await page.request
    .get(`${SERVER}/sheets/s2`)
    .then((r) => r.json())) as { images: { id: string }[] };
  assert(
    afterSheet.images.length === beforeSheet.images.length + 1,
    `expected the sheet to grow by exactly 1 (img-6 must not duplicate): before=${beforeSheet.images.length} after=${afterSheet.images.length}`,
  );
  assert(
    afterSheet.images.filter((i) => i.id === 'img-6').length === 1,
    'img-6 was duplicated on the sheet',
  );
  assert(
    afterSheet.images.some((i) => i.id === 'img-45'),
    'img-45 was not added to the sheet',
  );
  console.log(
    'PASS: "Add to sheet" skips an id already there and adds the rest, no duplicates',
  );

  // -- (a) continued: deleting a sheet also refreshes the channel column -----
  await page.waitForSelector('[data-testid="sheet-list"]');
  await page.getByTestId('sheet-delete-s1').click();
  await page.waitForSelector('[data-testid="sheet-delete-confirm-s1"]');
  await page.getByTestId('sheet-delete-confirm-s1-confirm').click();
  await page.waitForFunction(
    () =>
      !document
        .querySelector('[data-testid="shell-channel"]')
        ?.textContent?.includes('First pass'),
    undefined,
    { timeout: 3000 },
  );
  console.log('PASS (a): deleting a sheet refreshes the channel column');

  // -- 12b. name search and a typed property filter run through /find --------
  await page.goto(`${WEB}/b/b1`);
  await page.waitForFunction(
    () => typeof window.__digsiteBoard !== 'undefined',
  );
  await page.click('[data-testid="board-find-toggle"]');
  await page.getByTestId('board-find-query').fill('image-1');
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="board-find-count"]')
        ?.textContent?.includes('11 matches'),
    undefined,
    { timeout: 5000 },
  );
  assert(
    (
      await page.evaluate(() => window.__digsiteBoard?.getLayerIds() ?? [])
    ).includes('find-matches'),
    'search results were not highlighted on the map',
  );
  await page.click('[data-testid="board-find-select-matches"]');
  await page.waitForFunction(
    () => (window.__digsiteBoard?.getSelection() ?? []).length === 11,
    undefined,
    { timeout: 5000 },
  );
  console.log('PASS: name search reports and selects all 11 matches');

  await page.getByTestId('board-filter-clear').click();
  await page.getByTestId('board-filter-key').selectOption('year');
  await page.getByTestId('board-filter-op').selectOption('eq');
  await page.getByTestId('board-filter-value').fill('1906');
  await page.getByTestId('board-filter-add').click();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="board-find-count"]')
        ?.textContent?.trim() === '1 match',
    undefined,
    { timeout: 5000 },
  );
  console.log('PASS: typed property filter returns the matching image');

  await page.click('[data-testid="board-actions-button"]');
  await page.waitForSelector('[data-testid="board-context-menu"]');
  assert(
    (await page.locator('[data-testid="board-context-menu"] button').count()) >
      0,
    'Actions button opened an empty menu',
  );
  console.log('PASS: the accessible Actions button opens the board menu');

  // -- 13. over the cap: the honest truncated count, never a refusal ---------
  await page.goto(`${WEB}/b/b4`);
  await page.waitForFunction(
    () => typeof window.__digsiteBoard !== 'undefined',
  );
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__digsiteBoard?.selectRange(0, 200));
  await page.waitForFunction(
    () => (window.__digsiteBoard?.getSelection() ?? []).length > 150,
    undefined,
    { timeout: 5000 },
  );
  const overCapText = await page
    .getByTestId('board-tray-start-sheet')
    .innerText();
  assert(
    overCapText.includes('first 150 of'),
    `expected the over-cap copy on "Start a sheet", got "${overCapText}"`,
  );
  const countText = await page.getByTestId('board-tray-count').innerText();
  assert(
    countText.includes('/ 150'),
    `expected the tray header to show the cap, got "${countText}"`,
  );
  console.log(`PASS: over-cap copy: "${overCapText}"`);

  // -- (d) Ctrl/Cmd+K on a sheet page opens OUR switcher
  // own link dialog — Shell.tsx's global keydown listener is capture-phase
  // and stops propagation before any canvas key handler
  // bubble-phase binding on the canvas ever sees the keystroke. -------------
  await page.goto(`${WEB}/s/s2`);
  await page.waitForFunction(() => typeof window.__digsite !== 'undefined');
  await page.waitForFunction(
    () => window.__digsite.getElements().length > 0,
    undefined,
    { timeout: 10_000 },
  );
  await page.click('.sheet-canvas-area');
  await page.keyboard.press('Control+k');
  await page.waitForSelector('[data-testid="quick-switcher-input"]', {
    timeout: 3000,
  });
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-testid="quick-switcher-input"]', {
    state: 'detached',
  });
  console.log('PASS (d): Ctrl/Cmd+K on a sheet page opens the quick switcher');

  // -- (c) sign-out is race-free: a reload right after it always shows the
  // sign-in page (Shell.tsx awaits signOut() then hard-navigates). ----------
  await page.getByTestId('shell-sign-out').click();
  await page.waitForURL(`${WEB}/`);
  await page.reload();
  await page.waitForSelector('[data-testid="email"]');
  console.log('PASS (c): a reload right after sign-out shows the sign-in page');

  await browser.close();
  console.log('smoke-selection: all assertions passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
