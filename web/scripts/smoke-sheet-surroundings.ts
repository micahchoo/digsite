// Focused chrome checks for slice 3 sheet surroundings. Drives the isolated
// web stub and real canvas UI; it does not edit sheet data or scene elements.
import { type Page, chromium } from 'playwright';

const WEB = process.env.WEB_ORIGIN ?? 'http://localhost:5180';
const FOCUSABLE =
  'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

async function signIn(page: Page) {
  await page.goto(WEB);
  await page.getByTestId('email').fill('owner@example.test');
  await page.getByTestId('password').fill('password1');
  await page.getByTestId('submit').click();
  await page.waitForURL(/\/groups$/);
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1440, height: 920 },
  });
  await signIn(page);

  // Board-scoped list order drives both directions and stops at each end.
  await page.goto(`${WEB}/s/s1`);
  await page.waitForSelector('#sheet-inspector-panel');
  await page.getByRole('button', { name: 'Next sheet: Faces' }).click();
  await page.waitForURL(/\/s\/s2$/);
  await page
    .getByRole('button', { name: 'Previous sheet: First pass' })
    .click();
  await page.waitForURL(/\/s\/s1$/);
  console.log('PASS: previous and next follow board sheet order');
  await page.getByRole('button', { name: 'Next sheet: Faces' }).click();
  await page.waitForURL(/\/s\/s2$/);
  await page.screenshot({
    path: '/tmp/sheet-surroundings-desktop.png',
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  const toggle = page.locator('.sheet-mobile-inspector-toggle');
  await toggle.click();
  const panel = page.locator('#sheet-inspector-panel');
  const box = await panel.boundingBox();
  const semantics = await panel.evaluate((element) => ({
    role: element.getAttribute('role'),
    modal: element.getAttribute('aria-modal'),
  }));
  assert(
    box && box.x >= 0 && box.x + box.width <= 390,
    `390px inspector is outside viewport: ${JSON.stringify(box)}`,
  );
  assert(
    semantics.role === 'dialog' && semantics.modal === 'true',
    `mobile inspector is not a modal dialog: ${JSON.stringify(semantics)}`,
  );
  assert(
    (await page.locator('.sheet-canvas-area').getAttribute('inert')) !== null,
    'canvas remained interactive while the inspector was modal',
  );
  await panel.locator(FOCUSABLE).first().focus();
  await page.keyboard.press('Shift+Tab');
  assert(
    await panel
      .locator(FOCUSABLE)
      .last()
      .evaluate((node) => node === document.activeElement),
    'Shift+Tab escaped the inspector focus cycle',
  );

  const relationFilter = page.locator('#foreign-relation-filter');
  if (await relationFilter.isVisible()) {
    const shapesBefore = await page
      .locator('[data-testid="foreign-shape"][data-foreign-kind="edge"]')
      .count();
    const sceneBefore = await page.evaluate(() =>
      window.__digsite.getElements().map((element) => element.id),
    );
    if ((await relationFilter.locator('option').count()) > 1) {
      await relationFilter.selectOption({ index: 1 });
      const shapesAfter = await page
        .locator('[data-testid="foreign-shape"][data-foreign-kind="edge"]')
        .count();
      const sceneAfter = await page.evaluate(() =>
        window.__digsite.getElements().map((element) => element.id),
      );
      assert(
        shapesAfter === shapesBefore,
        'relation emphasis removed foreign connection shapes',
      );
      assert(
        JSON.stringify(sceneAfter) === JSON.stringify(sceneBefore),
        'foreign relation emphasis changed the shared scene',
      );
      console.log(
        'PASS: relation emphasis preserves overlay and scene elements',
      );
    }
    await relationFilter.focus();
    await page.waitForTimeout(3200); // one foreign poll and parent rerender
    assert(
      await relationFilter.evaluate((node) => node === document.activeElement),
      'a foreign poll stole focus while editing the relation filter',
    );
  }

  await page.screenshot({
    path: '/tmp/sheet-surroundings-390.png',
    fullPage: true,
  });
  await page.keyboard.press('Escape');
  assert(
    (await toggle.getAttribute('aria-expanded')) === 'false',
    'Escape did not close the inspector',
  );
  assert(
    (await page.evaluate(() =>
      document.activeElement?.getAttribute('aria-controls'),
    )) === 'sheet-inspector-panel',
    'closing the inspector did not restore focus to Details',
  );
  console.log('PASS: Escape closes the inspector and restores focus');

  await toggle.click();
  await page.setViewportSize({ width: 1440, height: 920 });
  await page.waitForFunction(
    () =>
      document.querySelector('.sheet-canvas-area')?.hasAttribute('inert') ===
      false,
  );
  assert(
    (await toggle.getAttribute('aria-expanded')) === 'false',
    'resizing to desktop left the mobile inspector open',
  );
  console.log(
    'PASS: resizing to desktop restores the canvas and closes drawer',
  );

  await page.setViewportSize({ width: 320, height: 740 });
  await toggle.click();
  const narrowBox = await panel.boundingBox();
  const narrowWidth = await page.evaluate(
    () => document.documentElement.scrollWidth,
  );
  assert(
    narrowBox && narrowBox.x >= 0 && narrowBox.x + narrowBox.width <= 320,
    `320px inspector is outside viewport: ${JSON.stringify(narrowBox)}`,
  );
  assert(narrowWidth <= 320, `320px page overflows to ${narrowWidth}px`);
  await page.screenshot({
    path: '/tmp/sheet-surroundings-320.png',
    fullPage: true,
  });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  await page.screenshot({
    path: '/tmp/sheet-surroundings-dark.png',
    fullPage: true,
  });
  console.log(
    'PASS: 320px inspector fits; desktop, narrow, and dark captures saved',
  );

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
