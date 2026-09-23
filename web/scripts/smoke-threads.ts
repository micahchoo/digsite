import { chromium } from 'playwright';

const WEB = process.env.WEB_ORIGIN ?? 'http://localhost:5180';
const SERVER = process.env.SERVER_ORIGIN ?? 'http://localhost:8800';
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  await page.goto(WEB);
  await page.getByTestId('email').fill('owner@example.test');
  await page.getByTestId('password').fill('password1');
  await page.getByTestId('submit').click();
  await page.waitForURL(/\/groups$/);
  await page.goto(`${WEB}/b/b1`);
  await page.getByTestId('thread-browser-open').click();
  await page.getByTestId('thread-search').fill('Faces');
  const row = page.locator('[data-testid="thread-row"][data-sheet-id="s2"]');
  await row.waitFor();
  assert(
    (await page.getByTestId('thread-row').count()) === 1,
    'sheet search did not narrow results',
  );
  assert((await row.locator('img').count()) > 0, 'thread preview is missing');
  await row.getByTestId('thread-archive').click();
  await row.waitFor({ state: 'hidden' });
  await page.waitForFunction(
    () =>
      !document.querySelector('[data-testid="shell-channel"] a[href="/s/s2"]'),
  );
  await page.getByTestId('thread-status').selectOption('archived');
  await row.waitFor();
  const retained = await page.request.get(`${SERVER}/sheets/s2`);
  assert(retained.status() === 200, 'archive made sheet inaccessible');
  await page.setViewportSize({ width: 320, height: 760 });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  await page.waitForTimeout(200);
  const bounds = await page.getByTestId('thread-browser').boundingBox();
  assert(
    bounds && bounds.x >= 0 && bounds.x + bounds.width <= 320,
    'sheet browser clips mobile viewport',
  );
  await page.screenshot({
    path: new URL('../screenshots/threads-mobile.png', import.meta.url)
      .pathname,
  });
  await row.getByTestId('thread-archive').click();
  await row.waitFor({ state: 'hidden' });
  await page.getByTestId('thread-status').selectOption('active');
  await row.waitFor();
  await page.keyboard.press('Escape');
  await page.getByTestId('thread-browser').waitFor({ state: 'hidden' });
  console.log(
    'PASS: search, previews, archive/reopen, preserved access, mobile layout and Escape',
  );
} finally {
  await browser.close();
}
