// A definition-of-done smoke script for slice 1 of docs/ux/design.md — THE
// SHELL (§7 "Slice 1 — Shell"). Drives the running dev server (`bun run
// dev`) against the stub (`bun run stub`). Exits nonzero on any failed
// assertion. Covers exactly what design.md's own slice-1 smoke line asks
// for, plus the shell-specific pieces called out in this slice's task:
//
//   - the rail switches group without a full reload (a window-scoped
//     sentinel survives — proof the rail/channel column were never
//     unmounted, not just visually stable)
//   - the channel column shows boards and nested sheets (docs/phases/
//     6-product.md "Sheets are threads")
//   - the breadcrumb on a sheet reads "board › sheet"
//   - Ctrl+K finds a sheet by partial name and navigates to it
//   - at 390x844 the drawer opens and closes, and the sheet canvas is at
//     least 90% of the viewport width with the toolbar fully on-screen
//     (docs/ux/audit.md #4)
import { chromium } from 'playwright';

const WEB = process.env.WEB_ORIGIN ?? 'http://localhost:5180';
const SCREEN_DIR = new URL('../screenshots/', import.meta.url);

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${message}`);
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1600, height: 900 },
  });

  // -- sign in (the stub accepts any credentials) --------------------------
  await page.goto(WEB);
  await page.getByTestId('email').fill('owner@example.test');
  await page.getByTestId('password').fill('password1');
  await page.getByTestId('submit').click();
  await page.waitForURL(/\/groups$/);
  console.log('signed in');

  // -- 1. every route renders inside the shell frame ------------------------
  await page.waitForSelector('[data-testid="shell-root"]');
  await page.waitForSelector('[data-testid="shell-rail"]');
  await page.waitForSelector('[data-testid="shell-topbar"]');
  console.log(
    'PASS: /groups renders inside the shell (rail + top bar present)',
  );

  // -- 2. channel column: boards, and a board's sheets nested beneath it ----
  await page.goto(`${WEB}/g/g1`);
  await page.waitForSelector('[data-testid="shell-board-link"]');
  const channelText = await page.getByTestId('shell-channel').innerText();
  assert(
    channelText.includes('Field'),
    `channel column missing "Field": ${channelText}`,
  );
  assert(
    channelText.includes('First pass'),
    `channel column missing nested sheet "First pass": ${channelText}`,
  );
  assert(
    channelText.includes('Faces'),
    `channel column missing nested sheet "Faces": ${channelText}`,
  );
  const sheetLinks = await page.getByTestId('shell-sheet-link').count();
  assert(
    sheetLinks >= 2,
    `expected at least 2 nested sheet links, got ${sheetLinks}`,
  );
  console.log(
    'PASS: channel column shows boards with sheets nested beneath them',
  );

  await page.screenshot({
    path: new URL('shell-desktop.png', SCREEN_DIR).pathname,
  });
  console.log('screenshot: shell-desktop.png');

  // Group landing visual acceptance: capture both themes at desktop and
  // narrow widths, and assert that the shell/page never create horizontal
  // overflow. The canvas itself remains governed by its own fixed map rules.
  await page.goto(`${WEB}/g/g1`);
  await page.waitForSelector('#group-boards-heading');
  await page.waitForFunction(
    () =>
      [
        ...document.querySelectorAll<HTMLImageElement>(
          '.group-board-preview img',
        ),
      ].length > 0 &&
      [
        ...document.querySelectorAll<HTMLImageElement>(
          '.group-board-preview img',
        ),
      ].every((image) => image.naturalWidth > 0),
    undefined,
    { timeout: 10_000 },
  );
  const previewCounts = await page
    .locator('.group-board-preview-images')
    .evaluateAll((previews) =>
      previews.map((preview) => preview.children.length),
    );
  assert(
    previewCounts.length > 0 && previewCounts.every((count) => count <= 3),
    `board cards should show at most three real previews each: ${JSON.stringify(previewCounts)}`,
  );
  console.log('PASS: visible board covers load real, bounded image previews');
  for (const viewport of [
    { width: 1440, height: 1000, label: 'desktop' },
    { width: 390, height: 844, label: '390' },
    { width: 320, height: 800, label: '320' },
  ]) {
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((value) => {
        if (value === 'dark') document.documentElement.dataset.theme = value;
        else document.documentElement.removeAttribute('data-theme');
      }, theme);
      await page.waitForTimeout(200);
      await page.screenshot({
        path: `/tmp/digsite-group-${viewport.label}-${theme}.png`,
        fullPage: true,
      });
      const dimensions = await page.evaluate(() => ({
        viewport: window.innerWidth,
        document: document.documentElement.scrollWidth,
        group: document.querySelector('.group-home')?.scrollWidth ?? 0,
      }));
      assert(
        dimensions.document <= dimensions.viewport + 1 &&
          dimensions.group <= dimensions.viewport + 1,
        `group landing overflows horizontally at ${viewport.label}/${theme}: ${JSON.stringify(dimensions)}`,
      );
    }
  }
  console.log(
    'PASS: group landing fits desktop, 390px and 320px in light and dark themes',
  );
  await page.goto(`${WEB}/groups`);
  await page.waitForSelector('[data-testid="group-list"]');
  for (const viewport of [
    { width: 1440, height: 1000, label: 'desktop' },
    { width: 390, height: 844, label: '390' },
    { width: 320, height: 800, label: '320' },
  ]) {
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((value) => {
        if (value === 'dark') document.documentElement.dataset.theme = value;
        else document.documentElement.removeAttribute('data-theme');
      }, theme);
      await page.waitForTimeout(200);
      await page.screenshot({
        path: `/tmp/digsite-groups-${viewport.label}-${theme}.png`,
        fullPage: true,
      });
      const dimensions = await page.evaluate(() => ({
        viewport: window.innerWidth,
        document: document.documentElement.scrollWidth,
      }));
      assert(
        dimensions.document <= dimensions.viewport + 1,
        `groups index overflows horizontally at ${viewport.label}/${theme}: ${JSON.stringify(dimensions)}`,
      );
    }
  }
  console.log(
    'PASS: groups index fits desktop, 390px and 320px in light and dark themes',
  );
  await page.evaluate(() =>
    document.documentElement.removeAttribute('data-theme'),
  );
  await page.setViewportSize({ width: 1600, height: 900 });

  // -- 3. the rail switches group without a full reload ---------------------
  // Not asserted === 1: Vite's dev server runs React StrictMode, which
  // double-invokes an empty-dependency effect once on a genuine first
  // mount (mount -> cleanup -> mount) — so 2 is the honest baseline in
  // dev, same as 1 would be in a production build. What the sentinel
  // actually proves is below: this number must NOT climb again on a route
  // change, which a real remount would cause regardless of StrictMode.
  const mountsBefore = await page.evaluate(() => window.__digsiteShell?.mounts);
  assert(
    typeof mountsBefore === 'number' && mountsBefore > 0,
    `expected the shell mount sentinel to be set, got ${mountsBefore}`,
  );

  await page
    .locator('[data-testid="shell-rail-group"][data-group-id="g2"]')
    .click();
  await page.waitForURL(/\/g\/g2$/);
  await page.waitForFunction(() =>
    document
      .querySelector('[data-testid="shell-channel"]')
      ?.textContent?.includes('Annex board'),
  );
  const mountsAfter = await page.evaluate(() => window.__digsiteShell?.mounts);
  assert(
    mountsAfter === mountsBefore,
    `shell remounted on a group switch: mounts went from ${mountsBefore} to ${mountsAfter}`,
  );
  console.log(
    `PASS: rail switched group g1 -> g2 (URL + channel column updated), shell mount count stayed ${mountsAfter} — no full reload`,
  );

  // -- 4. breadcrumb on a sheet reads "board › sheet" ------------------------
  await page.goto(`${WEB}/s/s1`);
  await page.waitForSelector('[data-testid="shell-breadcrumb"]');
  await page.waitForFunction(
    () =>
      (document.querySelector('[data-testid="shell-breadcrumb"]')?.textContent
        ?.length ?? 0) > 1,
  );
  const breadcrumbText = await page.getByTestId('shell-breadcrumb').innerText();
  assert(
    breadcrumbText.includes('Field'),
    `breadcrumb missing the board name: "${breadcrumbText}"`,
  );
  assert(
    breadcrumbText.includes('First pass'),
    `breadcrumb missing the sheet name: "${breadcrumbText}"`,
  );
  assert(
    breadcrumbText.includes('›'),
    `breadcrumb missing the board -> sheet separator: "${breadcrumbText}"`,
  );
  console.log(`PASS: sheet breadcrumb reads "${breadcrumbText.trim()}"`);

  // -- 5. Ctrl+K finds a sheet by partial name and navigates -----------------
  await page.goto(`${WEB}/g/g1`);
  await page.waitForSelector('[data-testid="shell-board-link"]');
  await page.waitForFunction(
    () =>
      document.querySelectorAll('[data-testid="shell-sheet-link"]').length >= 2,
  );
  await page.keyboard.press('Control+k');
  await page.waitForSelector('[data-testid="quick-switcher-input"]');
  await page.getByTestId('quick-switcher-input').fill('Fac');
  await page.waitForSelector('[data-testid="quick-switcher-item"]');
  const itemsText = await page
    .getByTestId('quick-switcher-item')
    .allInnerTexts();
  assert(
    itemsText.some((t) => t.includes('Faces')),
    `quick switcher found no "Faces" for query "Fac": ${JSON.stringify(itemsText)}`,
  );
  await page.screenshot({
    path: new URL('shell-switcher.png', SCREEN_DIR).pathname,
  });
  console.log('screenshot: shell-switcher.png');
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/s\/s2$/);
  console.log(
    'PASS: Ctrl+K found "Faces" from partial query "Fac" and navigated to it',
  );

  // -- 6. tablet (768-1279px): rail + channel column stay static, nothing
  // clips (design.md §3.2). The right column itself isn't populated yet —
  // Board.tsx/Sheet.tsx still carry their own inline panel, not the shell's
  // (see Shell.tsx's own comment on `hasRightColumn`) — so this checks the
  // rail/channel/top bar shape survives the narrower width instead.
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.goto(`${WEB}/b/b1`);
  await page.waitForSelector('canvas');
  await page.waitForSelector('[data-testid="shell-hamburger"]', {
    state: 'hidden',
  });
  const railBoxAtTablet = await page.getByTestId('shell-rail').boundingBox();
  assert(railBoxAtTablet, 'rail should stay static (not a drawer) at 1000px');
  assert(
    railBoxAtTablet.x >= -0.5,
    `rail clips off the left edge at 1000px: x=${railBoxAtTablet.x}`,
  );
  console.log(
    'PASS: at 1000px the rail and channel column stay static, no clipping',
  );
  await page.screenshot({
    path: new URL('shell-tablet.png', SCREEN_DIR).pathname,
  });
  console.log('screenshot: shell-tablet.png');

  // -- 7. mobile: the rail+channel drawer opens/closes, canvas + toolbar fit -
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${WEB}/s/s1`);
  await page.waitForSelector('[data-testid="sheet-toolbar"]');
  await page.waitForFunction(() => typeof window.__digsite !== 'undefined');
  await page.waitForFunction(
    () => window.__digsite.getElements().length > 0,
    undefined,
    { timeout: 10_000 },
  );
  await page.waitForTimeout(500);

  // drawer closed initially: rail/channel not part of the flow, hamburger visible
  await page.waitForSelector('[data-testid="shell-hamburger"]');
  const railHiddenInitially = await page.getByTestId('shell-rail').isHidden();
  assert(
    railHiddenInitially,
    'at 390px the rail should be hidden until the drawer opens',
  );

  await page.getByTestId('shell-hamburger').click();
  await page.waitForFunction(() => {
    const scrim = document.querySelector('[data-testid="shell-drawer-scrim"]');
    if (!scrim) return false;
    return getComputedStyle(scrim).display !== 'none';
  });
  const railVisibleOpen = await page.getByTestId('shell-rail').isVisible();
  assert(railVisibleOpen, 'the drawer should show the rail once opened');
  console.log('PASS: the mobile drawer opens (rail visible, scrim shown)');

  // The scrim spans the full viewport (`inset: 0`) but the drawer itself
  // (rail + channel, 280px wide, higher z-index) covers its left edge —
  // a raw click at the scrim's own bounding-box centre would land on the
  // drawer instead and never fire the scrim's close handler. Click well to
  // the right of the drawer's width, still inside the 390px viewport.
  await page
    .getByTestId('shell-drawer-scrim')
    .click({ force: true, position: { x: 350, y: 400 } });
  await page.waitForFunction(() => {
    const scrim = document.querySelector('[data-testid="shell-drawer-scrim"]');
    if (!scrim) return true;
    return getComputedStyle(scrim).display === 'none';
  });
  const railHiddenAfterClose = await page.getByTestId('shell-rail').isHidden();
  assert(
    railHiddenAfterClose,
    'the drawer should hide the rail again once closed',
  );
  console.log('PASS: the mobile drawer closes (scrim gone, rail hidden again)');

  const canvasBox = await page.locator('.sheet-canvas-area').boundingBox();
  assert(canvasBox, 'no .sheet-canvas-area found on the sheet page');
  const ratio = canvasBox.width / 390;
  assert(
    ratio >= 0.9,
    `sheet canvas is only ${(ratio * 100).toFixed(1)}% of the 390px viewport width`,
  );
  console.log(
    `PASS: sheet canvas is ${(ratio * 100).toFixed(1)}% of the viewport width at 390px`,
  );

  const toolbarBox = await page.getByTestId('sheet-toolbar').boundingBox();
  assert(toolbarBox, 'no sheet toolbar found');
  assert(
    toolbarBox.x >= -0.5 && toolbarBox.x + toolbarBox.width <= 390.5,
    `sheet toolbar clips the 390px viewport: x=${toolbarBox.x} width=${toolbarBox.width}`,
  );
  console.log(
    'PASS: the sheet toolbar is fully within the 390px viewport, not clipped',
  );

  await page.screenshot({
    path: new URL('shell-mobile.png', SCREEN_DIR).pathname,
  });
  console.log('screenshot: shell-mobile.png');

  await browser.close();
  console.log('smoke-shell: all assertions passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
