// The rest of the app at a phone's width (docs/roadmap.md horizon 6, "the
// rest of the app's surfaces at phone width"). smoke-surfaces.ts covers the
// making-sense surfaces, smoke-shell.ts the group landing and the drawers,
// smoke-threads.ts the sheet browser. This walks what none of them do: the
// pages before a group, and the board's own panels. Each one fits the
// screen with no sideways scroll, and its main control is in reach.
// Screenshots land in web/screenshots/phone-*.png.
//
// Against the stub: b1 is open with images; b2 is private, made by admin.
import { type Browser, type Page, chromium } from 'playwright';
import { assert, fits, reachable } from './layout-checks.ts';

const WEB = process.env.WEB_ORIGIN ?? 'http://localhost:5180';
const SCREEN_DIR = new URL('../screenshots/', import.meta.url);

async function shot(page: Page, name: string) {
  await page.waitForTimeout(300);
  await page.screenshot({
    path: new URL(`phone-${name}.png`, SCREEN_DIR).pathname,
  });
}

const errors: string[] = [];

async function phone(browser: Browser, width: number): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 844 } });
  page.on('pageerror', (err) => errors.push(`${width}px: ${err.message}`));
  return page;
}

async function signIn(page: Page, email: string) {
  await page.goto(WEB);
  await page.getByTestId('email').fill(email);
  await page.getByTestId('password').fill('password1');
  await page.getByTestId('submit').click();
  await page.waitForURL(/\/groups$/);
}

async function beforeAGroup(browser: Browser, width: number) {
  const page = await phone(browser, width);
  await page.goto(WEB);
  await page.getByTestId('submit').waitFor();
  await fits(page, `${width} sign in`);
  for (const id of ['email', 'password', 'submit'])
    await reachable(page, id, `${width} sign in`);
  await shot(page, `${width}-sign-in`);

  await page.goto(`${WEB}/join/inv-closed`);
  await page.getByTestId('join-status').waitFor();
  await fits(page, `${width} join`);
  await reachable(page, 'join-status', `${width} join`);
  await shot(page, `${width}-join`);

  await signIn(page, 'owner@example.test');
  await page.getByTestId('group-list').waitFor();
  await fits(page, `${width} groups`);
  await reachable(page, 'group-name', `${width} groups`);
  await reachable(page, 'invitation-input', `${width} groups`);
  await shot(page, `${width}-groups`);
  await page.close();
  console.log(`PASS: ${width}: sign in, join and the groups list fit`);
}

async function theBoard(browser: Browser) {
  const page = await phone(browser, 390);
  await signIn(page, 'owner@example.test');
  await page.goto(`${WEB}/b/b1`);
  await page.getByTestId('sort-key').waitFor();
  await page.waitForTimeout(3000);
  await fits(page, 'board');
  for (const id of ['sort-key', 'board-find-toggle', 'board-zoom-in'])
    await reachable(page, id, 'board');
  await shot(page, 'board');
  console.log('PASS: 390: the board map, its arrange control and zoom');

  // One picture selected: its details in the side drawer.
  await page.evaluate(() =>
    (
      window as unknown as {
        __digsiteBoard: { selectIds: (ids: string[]) => void };
      }
    ).__digsiteBoard.selectIds(['img-3']),
  );
  await page.getByTestId('shell-right-toggle').click();
  await page.getByTestId('detail-panel').waitFor({ timeout: 10_000 });
  await page.waitForTimeout(400);
  await fits(page, 'board details');
  await reachable(page, 'detail-panel', 'board details');
  await shot(page, 'board-details');
  await page.keyboard.press('Escape');
  console.log("PASS: 390: a picture's details open in the side drawer");

  // An upload in progress: the queue card over the map.
  await page.goto(`${WEB}/b/b1`);
  await page.getByTestId('sort-key').waitFor();
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  await page.getByTestId('upload-input').setInputFiles([
    { name: 'phone-a.png', mimeType: 'image/png', buffer: png },
    { name: 'phone-b.png', mimeType: 'image/png', buffer: png },
  ]);
  await page.getByTestId('upload-list').waitFor({ timeout: 10_000 });
  await fits(page, 'upload queue');
  await reachable(page, 'upload-counts', 'upload queue');
  await shot(page, 'upload-queue');
  console.log('PASS: 390: the upload queue fits over the map');
  await page.close();

  // A private board's allowlist, as the admin who made it.
  const admin = await phone(browser, 390);
  await signIn(admin, 'admin@example.test');
  await admin.goto(`${WEB}/b/b2`);
  await admin.getByTestId('sort-key').waitFor();
  await admin.getByTestId('shell-right-toggle').click();
  await admin.getByTestId('allowlist-card').waitFor({ timeout: 10_000 });
  await admin.getByTestId('allowlist-card').scrollIntoViewIfNeeded();
  await admin.waitForTimeout(400);
  await fits(admin, 'allowlist');
  await reachable(admin, 'allowlist-add-select', 'allowlist');
  await reachable(admin, 'allowlist-add', 'allowlist');
  await shot(admin, 'allowlist');
  console.log("PASS: 390: a private board's allowlist is in reach");
  await admin.close();
}

async function main() {
  const browser = await chromium.launch();
  try {
    await beforeAGroup(browser, 390);
    await beforeAGroup(browser, 320);
    await theBoard(browser);
    assert(errors.length === 0, `page errors: ${errors.join(' | ')}`);
    console.log('smoke-phone: all assertions passed');
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
