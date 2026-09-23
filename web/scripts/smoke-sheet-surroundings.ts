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
  await page.route('**/sheets/s2/foreign', async (route) => {
    const response = await route.fetch();
    const payload = (await response.json()) as {
      regions: Array<Record<string, unknown>>;
      edges: unknown[];
    };
    const base = payload.regions.find((region) => region.imageId === 'img-8');
    if (base) {
      for (const [id, label, sourceId] of [
        ['fixture-overlap-a', 'overlap alpha', 'fixture-a'],
        ['fixture-overlap-b', 'overlap beta', 'fixture-b'],
      ]) {
        payload.regions.push({
          ...base,
          id,
          label,
          sheetId: id,
          sheetName: label,
          sourceId,
        });
      }
    }
    await route.fulfill({ response, body: JSON.stringify(payload) });
  });
  await page.getByRole('button', { name: 'Next sheet: Faces' }).click();
  await page.waitForURL(/\/s\/s2$/);
  await page.waitForFunction(
    () => window.__digsite?.getElements().length === 12,
  );
  await page.evaluate(() =>
    window.__digsite.drawRegion(
      'img-8',
      { fx: 0.1, fy: 0.1, fw: 0.35, fh: 0.35 },
      'owned find',
    ),
  );
  await page.waitForFunction(
    () =>
      window.__digsite
        ?.getElements()
        .some(
          (element) =>
            (element.customData as { label?: string } | undefined)?.label ===
            'owned find',
        ) === true,
  );
  await page.waitForFunction(
    () =>
      document.querySelectorAll(
        '[data-testid="foreign-shape"][data-foreign-kind="region"]',
      ).length === 4,
  );
  await page.evaluate(() => window.__digsite.zoomToFit());
  await page.waitForTimeout(100);
  assert(
    await page.evaluate(
      () => (window.__digsiteSheetDebug?.getAppState()?.zoom.value ?? 1) < 1,
    ),
    'sheet fit did not show the full image grid',
  );
  assert(
    (await page.locator('[data-testid="connection-label"]').count()) > 0,
    'no connection labels were placed at desktop size',
  );
  const regionLabelBoxes = await page
    .locator('[data-testid="foreign-region-label-box"]')
    .evaluateAll((rects) =>
      rects.map((rect) => {
        const box = rect.getBoundingClientRect();
        return {
          id: rect.getAttribute('data-label-owner'),
          x: box.x,
          y: box.y,
          width: box.width,
          height: box.height,
        };
      }),
    );
  const overlappingClaimIds = await page.evaluate(() =>
    window.__digsite
      .getForeign()
      .filter(
        (shape) => shape.kind === 'region' && shape.row.imageId === 'img-8',
      )
      .map((shape) => shape.id),
  );
  const overlappingClaimLabels = regionLabelBoxes.filter((box) =>
    overlappingClaimIds.includes(box.id ?? ''),
  );
  assert(
    overlappingClaimLabels.length === 3,
    'not all three overlapping regions received labels',
  );
  for (let i = 0; i < overlappingClaimLabels.length; i += 1) {
    const box = overlappingClaimLabels[i];
    if (!box) continue;
    for (let j = i + 1; j < overlappingClaimLabels.length; j += 1) {
      const other = overlappingClaimLabels[j];
      if (!other) continue;
      assert(
        box.x + box.width <= other.x ||
          other.x + other.width <= box.x ||
          box.y + box.height <= other.y ||
          other.y + other.height <= box.y,
        'overlapping foreign region labels collided',
      );
    }
  }
  const ownRegionLabelBox = await page.evaluate(() => {
    const region = window.__digsite
      .getElements()
      .find(
        (element) =>
          (element.customData as { label?: string } | undefined)?.label ===
          'owned find',
      );
    const appState = window.__digsiteSheetDebug?.getAppState();
    const canvasArea = document
      .querySelector('.sheet-canvas-area')
      ?.getBoundingClientRect();
    if (!region || !appState || !canvasArea) return null;
    const ctx = document.createElement('canvas').getContext('2d');
    if (ctx) ctx.font = '11px system-ui, sans-serif';
    const rect = {
      x: (region.x + appState.scrollX) * appState.zoom.value,
      y: (region.y + appState.scrollY) * appState.zoom.value,
      width: region.width * appState.zoom.value,
      height: region.height * appState.zoom.value,
    };
    return {
      x: canvasArea.x + rect.x + 4,
      y: canvasArea.y + rect.y + 3,
      width: Math.min(
        ctx?.measureText('owned find').width ?? 70,
        Math.max(0, rect.width - 8),
      ),
      height: 14,
    };
  });
  assert(ownRegionLabelBox, 'own-region label fixture was not found');
  for (const box of regionLabelBoxes) {
    assert(
      box.x + box.width <= ownRegionLabelBox.x ||
        ownRegionLabelBox.x + ownRegionLabelBox.width <= box.x ||
        box.y + box.height <= ownRegionLabelBox.y ||
        ownRegionLabelBox.y + ownRegionLabelBox.height <= box.y,
      'foreign region label collided with the owned region label',
    );
  }
  const labelFixtureScene = await page.evaluate(() =>
    JSON.stringify(window.__digsite.getElements()),
  );
  await page
    .locator('[data-testid="foreign-region-label-box"]')
    .first()
    .click();
  assert(
    await page.evaluate(
      () => window.__digsite.getSelected()?.kind === 'foreign',
    ),
    'clicking a placed foreign label did not select its region',
  );
  assert(
    labelFixtureScene ===
      (await page.evaluate(() =>
        JSON.stringify(window.__digsite.getElements()),
      )),
    'placing/selecting foreign region labels changed the scene',
  );
  await page.screenshot({
    path: '/tmp/sheet-surroundings-desktop.png',
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.__digsite.zoomToFit());
  await page.waitForTimeout(100);
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

  const relationFilter = page.locator('#connection-relation-filter');
  if (await relationFilter.isVisible()) {
    const shapesBefore = await page
      .locator('[data-testid="foreign-shape"][data-foreign-kind="edge"]')
      .count();
    const sceneBefore = await page.evaluate(() =>
      JSON.stringify(window.__digsite.getElements()),
    );
    if ((await relationFilter.locator('option').count()) > 1) {
      await relationFilter.selectOption({ index: 1 });
      const shapesAfter = await page
        .locator('[data-testid="foreign-shape"][data-foreign-kind="edge"]')
        .count();
      const matchingForeignDimmed = await page
        .locator(
          '[data-testid="foreign-shape"][data-foreign-kind="edge"][data-relation-dimmed="true"]',
        )
        .count();
      const sceneAfter = await page.evaluate(() =>
        JSON.stringify(window.__digsite.getElements()),
      );
      assert(
        shapesAfter === shapesBefore,
        'relation emphasis removed foreign connection shapes',
      );
      assert(
        sceneAfter === sceneBefore,
        'foreign relation emphasis changed the shared scene',
      );
      assert(
        matchingForeignDimmed === 0,
        'matching foreign connection was incorrectly dimmed',
      );
      console.log(
        'PASS: relation emphasis preserves matching labels and scene elements',
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
