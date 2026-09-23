// Focused chrome checks for slice 3 sheet surroundings. Drives the isolated
// web stub and real canvas UI; it does not edit sheet data or scene elements.
import { type Page, chromium } from 'playwright';
import { regionChip } from '../src/sheet/labels.ts';

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
  // The chip the canvas draws for the own region's label (labels.ts).
  const ownRegion = await page.evaluate(() => {
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
    return {
      x: canvasArea.x + (region.x + appState.scrollX) * appState.zoom.value,
      y: canvasArea.y + (region.y + appState.scrollY) * appState.zoom.value,
      textWidth: ctx?.measureText('owned find').width ?? 70,
    };
  });
  const ownRegionLabelBox =
    ownRegion && regionChip(ownRegion, ownRegion.textWidth);
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

  // Native authoring regression: Shift-click accumulates a selection and a
  // drag on either selected image carries both groups. The scene transform
  // comes from the same viewport the sheet canvas reports to its overlay.
  await page.getByTestId('tool-select').click();
  const imageCenters = await page.evaluate(() => {
    const elements = window.__digsite.getElements().filter((element) => {
      const data = element.customData as { kind?: string } | undefined;
      return data?.kind === 'image' && !element.isDeleted;
    });
    const appState = window.__digsiteSheetDebug?.getAppState();
    const area = document
      .querySelector('.sheet-canvas-area')
      ?.getBoundingClientRect();
    if (!appState || !area) return [];
    return elements
      .map((element) => ({
        id: element.id,
        x:
          area.left +
          (element.x + element.width / 2 + appState.scrollX) *
            appState.zoom.value,
        y:
          area.top +
          (element.y + element.height / 2 + appState.scrollY) *
            appState.zoom.value,
        sceneX: element.x,
      }))
      .filter(
        (center) =>
          document.elementFromPoint(center.x, center.y)?.tagName === 'CANVAS',
      )
      .slice(0, 3);
  });
  assert(imageCenters.length === 3, 'three image centers were not available');
  const firstImage = imageCenters[0];
  const secondImage = imageCenters[1];
  const thirdImage = imageCenters[2];
  if (!firstImage || !secondImage || !thirdImage)
    throw new Error('missing image centers');
  await page.keyboard.down('Shift');
  await page.mouse.click(firstImage.x, firstImage.y);
  await page.mouse.click(secondImage.x, secondImage.y);
  await page.keyboard.up('Shift');
  await page.waitForFunction(
    (ids) =>
      ids.every(
        (id) =>
          window.__digsiteSheetDebug?.getAppState()?.selectedElementIds[id],
      ),
    [firstImage.id, secondImage.id],
    { timeout: 4000 },
  );
  await page.mouse.move(firstImage.x, firstImage.y);
  await page.mouse.down();
  await page.mouse.move(firstImage.x + 24, firstImage.y + 18, { steps: 3 });
  await page.mouse.up();
  await page.waitForFunction(
    ({ firstId, secondId, firstX, secondX }) => {
      const elements = window.__digsite.getElements();
      const first = elements.find((element) => element.id === firstId);
      const second = elements.find((element) => element.id === secondId);
      return first?.x !== firstX && second?.x !== secondX;
    },
    {
      firstId: firstImage.id,
      secondId: secondImage.id,
      firstX: firstImage.sceneX,
      secondX: secondImage.sceneX,
    },
  );
  console.log(
    'PASS: Shift-click selection moves selected image groups together',
  );

  await page.keyboard.down('Shift');
  await page.mouse.move(thirdImage.x, thirdImage.y);
  await page.mouse.down();
  await page.mouse.move(thirdImage.x + 24, thirdImage.y + 18, { steps: 3 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await page.waitForFunction(
    (id) => window.__digsiteSheetDebug?.getAppState()?.selectedElementIds[id],
    thirdImage.id,
  );
  assert(
    await page.evaluate(
      (ids) =>
        ids.every(
          (id) =>
            window.__digsiteSheetDebug?.getAppState()?.selectedElementIds[id],
        ),
      [firstImage.id, secondImage.id, thirdImage.id],
    ),
    'Shift-marquee did not retain the existing selection and add its hit',
  );
  console.log('PASS: Shift-marquee adds to the selection');

  // The drawing layer is above the canvas. Empty drags still pan, and Space
  // temporarily pans over an image without creating a region.
  await page.getByTestId('tool-region').click();
  const beforeEmptyPan = await page.evaluate(() =>
    window.__digsiteSheetDebug?.getAppState(),
  );
  const canvasArea = await page.locator('.sheet-canvas-area').boundingBox();
  assert(beforeEmptyPan && canvasArea, 'sheet viewport was not available');
  const regionCountBeforePan = await page.evaluate(
    () =>
      window.__digsite
        .getElements()
        .filter(
          (element) =>
            (element.customData as { kind?: string } | undefined)?.kind ===
              'region' && !element.isDeleted,
        ).length,
  );
  await page.mouse.move(canvasArea.x + 12, canvasArea.y + 12);
  await page.mouse.down();
  await page.mouse.move(canvasArea.x + 52, canvasArea.y + 42, { steps: 3 });
  await page.mouse.up();
  await page.waitForFunction(
    (scrollX) => window.__digsiteSheetDebug?.getAppState()?.scrollX !== scrollX,
    beforeEmptyPan.scrollX,
  );
  const emptyPanState = await page.evaluate(() =>
    window.__digsiteSheetDebug?.getAppState(),
  );
  assert(emptyPanState, 'sheet viewport disappeared after empty-space pan');

  const assertPointerAnchoredWheelZoom = async (
    toolTestId: 'tool-region' | 'tool-edge',
  ) => {
    await page.getByTestId(toolTestId).click();
    const box = await page.locator('.sheet-canvas-area').boundingBox();
    assert(box, 'canvas area was not available for wheel zoom');
    const point = { x: box.width / 2, y: box.height / 2 };
    const before = await page.evaluate((point) => {
      const appState = window.__digsiteSheetDebug?.getAppState();
      if (!appState) return null;
      return {
        zoom: appState.zoom.value,
        worldX: point.x / appState.zoom.value - appState.scrollX,
        worldY: point.y / appState.zoom.value - appState.scrollY,
      };
    }, point);
    assert(before, 'viewport was unavailable before wheel zoom');
    await page.mouse.move(box.x + point.x, box.y + point.y);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -120);
    await page.keyboard.up('Control');
    await page.waitForFunction(
      (zoom) => window.__digsiteSheetDebug?.getAppState()?.zoom.value !== zoom,
      before.zoom,
    );
    const after = await page.evaluate((point) => {
      const appState = window.__digsiteSheetDebug?.getAppState();
      if (!appState) return null;
      return {
        zoom: appState.zoom.value,
        worldX: point.x / appState.zoom.value - appState.scrollX,
        worldY: point.y / appState.zoom.value - appState.scrollY,
      };
    }, point);
    assert(after, 'viewport was unavailable after wheel zoom');
    assert(
      Math.abs(after.worldX - before.worldX) < 0.25 &&
        Math.abs(after.worldY - before.worldY) < 0.25,
      `${toolTestId} wheel zoom drifted away from the pointer: before=${JSON.stringify(before)} after=${JSON.stringify(after)} point=${JSON.stringify(point)}`,
    );
    return box;
  };
  const regionWheelBox = await assertPointerAnchoredWheelZoom('tool-region');
  const beforeWheelPan = await page.evaluate(() =>
    window.__digsiteSheetDebug?.getAppState(),
  );
  assert(beforeWheelPan, 'viewport was unavailable before wheel pan');
  await page.mouse.move(regionWheelBox.x + 32, regionWheelBox.y + 32);
  await page.mouse.wheel(0, 80);
  await page.waitForFunction(
    (scrollY) => window.__digsiteSheetDebug?.getAppState()?.scrollY !== scrollY,
    beforeWheelPan.scrollY,
  );
  await assertPointerAnchoredWheelZoom('tool-edge');

  const imageAfterEmptyPan = await page.evaluate((id) => {
    const element = window.__digsite
      .getElements()
      .find((item) => item.id === id);
    const appState = window.__digsiteSheetDebug?.getAppState();
    const area = document
      .querySelector('.sheet-canvas-area')
      ?.getBoundingClientRect();
    if (!element || !appState || !area) return null;
    return {
      x:
        area.left +
        (element.x + element.width / 2 + appState.scrollX) *
          appState.zoom.value,
      y:
        area.top +
        (element.y + element.height / 2 + appState.scrollY) *
          appState.zoom.value,
      sceneX: element.x,
      scrollX: appState.scrollX,
    };
  }, firstImage.id);
  assert(imageAfterEmptyPan, 'image position was not available after panning');
  await page.keyboard.down('Space');
  await page.mouse.move(imageAfterEmptyPan.x, imageAfterEmptyPan.y);
  await page.mouse.down();
  await page.mouse.move(imageAfterEmptyPan.x + 30, imageAfterEmptyPan.y + 12, {
    steps: 3,
  });
  await page.mouse.up();
  await page.keyboard.up('Space');
  await page.waitForFunction(
    ({ id, sceneX, scrollX, regionCount }) => {
      const element = window.__digsite
        .getElements()
        .find((item) => item.id === id);
      const regions = window.__digsite
        .getElements()
        .filter(
          (item) =>
            (item.customData as { kind?: string } | undefined)?.kind ===
              'region' && !item.isDeleted,
        );
      return (
        element?.x === sceneX &&
        window.__digsiteSheetDebug?.getAppState()?.scrollX !== scrollX &&
        regions.length === regionCount
      );
    },
    {
      id: firstImage.id,
      sceneX: imageAfterEmptyPan.sceneX,
      scrollX: imageAfterEmptyPan.scrollX,
      regionCount: regionCountBeforePan,
    },
  );
  console.log(
    'PASS: drawing tools pan through empty space and Space pans over images',
  );

  // A modifier must not turn an explicitly forced Space pan into a marquee.
  await page.getByTestId('tool-select').click();
  const forcedPanStart = await page.evaluate((id) => {
    const element = window.__digsite
      .getElements()
      .find((item) => item.id === id);
    const appState = window.__digsiteSheetDebug?.getAppState();
    const area = document
      .querySelector('.sheet-canvas-area')
      ?.getBoundingClientRect();
    if (!element || !appState || !area) return null;
    return {
      x:
        area.left +
        (element.x + element.width / 2 + appState.scrollX) *
          appState.zoom.value,
      y:
        area.top +
        (element.y + element.height / 2 + appState.scrollY) *
          appState.zoom.value,
      scrollX: appState.scrollX,
      selected: Object.keys(appState.selectedElementIds).sort(),
    };
  }, firstImage.id);
  assert(forcedPanStart, 'image position was not available for forced pan');
  await page.keyboard.down('Shift');
  await page.keyboard.down('Space');
  await page.mouse.move(forcedPanStart.x, forcedPanStart.y);
  await page.mouse.down();
  await page.mouse.move(forcedPanStart.x + 30, forcedPanStart.y + 12, {
    steps: 3,
  });
  await page.mouse.up();
  await page.keyboard.up('Space');
  await page.keyboard.up('Shift');
  await page.waitForFunction(({ scrollX, selected }) => {
    const state = window.__digsiteSheetDebug?.getAppState();
    return (
      !!state &&
      state.scrollX !== scrollX &&
      JSON.stringify(Object.keys(state.selectedElementIds).sort()) ===
        JSON.stringify(selected)
    );
  }, forcedPanStart);
  console.log('PASS: Space pan takes priority over Shift-marquee');

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

  const relationFilter = page.getByTestId('relation-emphasis');
  const relationOptions = page.getByTestId('relation-emphasis-option');
  if (await relationFilter.isVisible()) {
    const shapesBefore = await page
      .locator('[data-testid="foreign-shape"][data-foreign-kind="edge"]')
      .count();
    const sceneBefore = await page.evaluate(() =>
      JSON.stringify(window.__digsite.getElements()),
    );
    if ((await relationOptions.count()) > 0) {
      await relationOptions.first().check();
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
    await relationOptions.first().focus();
    await page.waitForTimeout(3200); // one foreign poll and parent rerender
    assert(
      await relationOptions
        .first()
        .evaluate((node) => node === document.activeElement),
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

// exit, not exitCode: a failure leaves Chromium open, and an open browser
// keeps the process alive, so the runner waited on a failed run forever.
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
