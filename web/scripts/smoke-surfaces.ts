// The quality floor for the surfaces of "making sense" (docs/roadmap.md,
// horizon 6): in dark mode on a desktop, and in light mode at a phone's
// width, every one of them opens, fits the screen without a sideways
// scroll, and its main control is where a person can reach it. Screenshots
// land in web/screenshots/surfaces-*.png for a person to read.
//
// Against the stub: s1 holds images 0..11 with a "resembles" edge.
import { type Page, chromium } from 'playwright';
import { assert, fits, reachable } from './layout-checks.ts';

const WEB = process.env.WEB_ORIGIN ?? 'http://localhost:5180';
const SCREEN_DIR = new URL('../screenshots/', import.meta.url);

async function shot(page: Page, name: string) {
  await page.waitForTimeout(300);
  await page.screenshot({
    path: new URL(`surfaces-${name}.png`, SCREEN_DIR).pathname,
  });
}

async function run(mode: 'dark' | 'phone') {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport:
      mode === 'phone'
        ? { width: 390, height: 844 }
        : { width: 1440, height: 900 },
    colorScheme: mode === 'dark' ? 'dark' : 'light',
  });
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto(WEB);
  await page.getByTestId('email').fill('owner@example.test');
  await page.getByTestId('password').fill('password1');
  await page.getByTestId('submit').click();
  await page.waitForURL(/\/groups$/);

  // -- the sheet, with a connection's details --------------------------------
  await page.goto(`${WEB}/s/s1`);
  await page.waitForFunction(
    () => (window.__digsite?.getElements().length ?? 0) > 0,
  );
  await page.waitForTimeout(1200);
  const edgeId = await page.evaluate(
    () =>
      window.__digsite
        .getElements()
        .find((e) => !e.isDeleted && e.customData?.kind === 'edge')?.id ?? '',
  );
  assert(edgeId, 'the stub sheet has no connection');
  await page.evaluate((id: string) => window.__digsite.select(id), edgeId);
  if (mode === 'phone') {
    await page.locator('.sheet-mobile-inspector-toggle').click();
  }
  await page.getByTestId('inspector-evidence').waitFor();
  await fits(page, `${mode} sheet`);
  await reachable(page, 'inspector-compare', `${mode} sheet`);
  await shot(page, `${mode}-sheet`);
  console.log(
    `PASS: ${mode}: a connection's details fit and Compare is reachable`,
  );

  // -- compare ----------------------------------------------------------------
  await page.getByTestId('inspector-compare').click();
  await page.getByTestId('compare').waitFor();
  await page.waitForFunction(() =>
    [...document.querySelectorAll<HTMLImageElement>('.compare-picture')].every(
      (img) => img.naturalWidth > 0,
    ),
  );
  await fits(page, `${mode} compare`);
  await reachable(page, 'compare-pane-a', `${mode} compare`);
  await shot(page, `${mode}-compare`);
  await page.keyboard.press('Escape');
  await page.getByTestId('compare').waitFor({ state: 'detached' });
  console.log(`PASS: ${mode}: Compare opens, fits and closes`);

  // -- the web around the connection ------------------------------------------
  // Closing Compare leaves the details open: its Esc belongs to the
  // dialog alone (lib/modal.ts).
  await page.getByTestId('inspector-open-web').waitFor({ timeout: 5000 });
  await page.getByTestId('inspector-open-web').click();
  await page.getByTestId('web-view').waitFor();
  await page.getByTestId('web-view-node').first().waitFor({ timeout: 10_000 });
  await fits(page, `${mode} web`);
  await reachable(page, 'web-view-node', `${mode} web`);
  await shot(page, `${mode}-web`);
  await page.keyboard.press('Escape');
  console.log(`PASS: ${mode}: the web view opens with its pictures in reach`);

  // -- the board: find by meaning, and how two pictures are connected ----------
  await page.goto(`${WEB}/b/b1`);
  await page.getByTestId('board-find-toggle').waitFor();
  await page.getByTestId('board-find-toggle').click();
  await page.getByTestId('board-find-mode-meaning').check();
  await page.getByTestId('board-find-query').fill('a harbour at dusk');
  await page
    .getByTestId('board-find-strip-item')
    .first()
    .waitFor({ timeout: 10_000 });
  await fits(page, `${mode} find`);
  // Found at 390 px: the page did not scroll, but the map's container did,
  // and the toolbar and Find sat 13 px off the left edge.
  const offscreen = await page.evaluate(() =>
    ['.board-toolbar', '.board-find'].filter((sel) => {
      const r = document.querySelector(sel)?.getBoundingClientRect();
      return !r || r.left < 0 || r.right > window.innerWidth;
    }),
  );
  assert(
    offscreen.length === 0,
    `${mode} find: off the screen: ${offscreen.join(', ')}`,
  );
  await reachable(page, 'board-find-strip-item', `${mode} find`);
  await shot(page, `${mode}-find`);
  console.log(
    `PASS: ${mode}: find by meaning shows its best pictures in reach`,
  );

  // -- two pictures in the tray, and how they are connected --------------------
  await page.getByTestId('board-find-toggle').click();
  await page.evaluate(() =>
    (
      window as unknown as {
        __digsiteBoard: { selectIds: (ids: string[]) => void };
      }
    ).__digsiteBoard.selectIds(['img-8', 'img-9']),
  );
  await page.getByTestId('board-tray-path').waitFor({ timeout: 10_000 });
  await fits(page, `${mode} tray`);
  await reachable(page, 'board-tray-path', `${mode} tray`);
  await page.getByTestId('board-tray-path').click();
  if (mode === 'phone') await page.getByTestId('shell-right-toggle').click();
  await page.getByTestId('board-path').waitFor({ timeout: 10_000 });
  await fits(page, `${mode} path`);
  // The shot's pause also lets the phone's side drawer finish sliding in.
  await shot(page, `${mode}-path`);
  await reachable(page, 'board-path', `${mode} path`);
  console.log(
    `PASS: ${mode}: the tray and the path panel fit and are in reach`,
  );

  // -- the keys, and the sheet's menu -----------------------------------------
  await page.goto(`${WEB}/s/s1`);
  await page.waitForFunction(
    () => (window.__digsite?.getElements().length ?? 0) > 0,
  );
  await page.waitForTimeout(800);
  await page.keyboard.press('?');
  await page.getByTestId('shortcuts-panel').waitFor();
  await fits(page, `${mode} keys`);
  await reachable(page, 'shortcuts-panel', `${mode} keys`);
  await shot(page, `${mode}-keys`);
  await page.keyboard.press('Escape');
  const canvas = await page.locator('.digsite-canvas').boundingBox();
  assert(canvas, 'no canvas');
  await page.mouse.click(
    canvas.x + canvas.width / 2,
    canvas.y + canvas.height / 2,
    {
      button: 'right',
    },
  );
  await page.getByTestId('sheet-context-menu').waitFor();
  const menuBox = await page.getByTestId('sheet-context-menu').boundingBox();
  const size = page.viewportSize();
  assert(
    menuBox &&
      size &&
      menuBox.x >= 0 &&
      menuBox.y >= 0 &&
      menuBox.x + menuBox.width <= size.width &&
      menuBox.y + menuBox.height <= size.height,
    `${mode}: the sheet menu leaves the screen: ${JSON.stringify(menuBox)}`,
  );
  await shot(page, `${mode}-menu`);
  await page.keyboard.press('Escape');
  console.log(`PASS: ${mode}: the keyboard panel and the sheet menu fit`);

  assert(errors.length === 0, `${mode}: page errors: ${errors.join(' | ')}`);
  await browser.close();
}

async function main() {
  await run('dark');
  await run('phone');
  console.log('smoke-surfaces: all assertions passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
