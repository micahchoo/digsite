// A definition-of-done smoke script, not a test suite: drives the running
// dev server (`bun run dev`) against the stub (`bun run stub`) and asserts
// the numbers docs/design.md's Definition of Done calls for. Exits nonzero
// on any failed assertion so it can gate a check.
import { fromFraction, toFraction } from '@digsite/shared';
import { chromium } from 'playwright';

const WEB = process.env.WEB_ORIGIN ?? 'http://localhost:5180';
const SCREEN_DIR = new URL('../screenshots/', import.meta.url);

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${message}`);
}

function close(a: number, b: number, eps: number): boolean {
  return Math.abs(a - b) <= eps;
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

  // -- board: tiles at two zooms --------------------------------------------
  await page.goto(`${WEB}/b/b1`);
  await page.waitForSelector('canvas');
  await page.waitForFunction(
    () => typeof window.__digsiteBoard !== 'undefined',
  );
  await page.waitForTimeout(500); // let the first tile batch land

  await page.evaluate(() => window.__digsiteBoard?.setZoom(0));
  await page.waitForTimeout(600);
  await page.screenshot({ path: new URL('board-z0.png', SCREEN_DIR).pathname });
  console.log('screenshot: board-z0.png');

  await page.evaluate(() => window.__digsiteBoard?.setZoom(-3));
  await page.waitForTimeout(600);
  await page.screenshot({
    path: new URL('board-z-3.png', SCREEN_DIR).pathname,
  });
  console.log('screenshot: board-z-3.png');

  // -- sheet: Faces (s2) sees First pass's (s1) claims as foreign ------------
  await page.goto(`${WEB}/s/s2`);
  await page.waitForFunction(() => typeof window.__digsite !== 'undefined');
  await page.waitForFunction(
    () => (window.__digsite.getForeign?.() ?? []).length > 0,
    undefined,
    { timeout: 10_000 },
  );
  // Image files decode async (fetch -> blob -> dataURL -> addFiles); give
  // Excalidraw a moment to paint them before the sheet screenshot.
  await page.waitForTimeout(3000);

  const noForeignInScene = await page.evaluate(() =>
    window.__digsite
      .getElements()
      .every(
        (el) =>
          !(
            el.customData &&
            typeof el.customData === 'object' &&
            'foreign' in el.customData
          ),
      ),
  );
  assert(
    noForeignInScene,
    'window.__digsite.getElements() must have no element with a foreign key',
  );
  console.log('PASS: no foreign key in any own element');

  // -- moveImage(img-8) then copyForeign in the same tick ---------------------
  const before = await page.evaluate(() => {
    const shape = window.__digsite
      .getForeign()
      .find((s) => s.kind === 'region' && s.row.imageId === 'img-8');
    return shape ?? null;
  });
  assert(before?.kind === 'region', 'expected a foreign region on img-8');

  const result = await page.evaluate((shapeId: string) => {
    window.__digsite.moveImage('img-8', 100, 50);
    const newId = window.__digsite.copyForeign(shapeId);
    const elements = window.__digsite.getElements();
    // biome-ignore lint/suspicious/noExplicitAny: page.evaluate crosses the browser boundary
    const copy = elements.find((e: any) => e.id === newId);
    const imgEl = elements.find(
      // biome-ignore lint/suspicious/noExplicitAny: page.evaluate crosses the browser boundary
      (e: any) =>
        e.customData?.kind === 'image' && e.customData.imageId === 'img-8',
    );
    return {
      newId,
      copy: copy
        ? { x: copy.x, y: copy.y, width: copy.width, height: copy.height }
        : null,
      imgEl: imgEl
        ? { x: imgEl.x, y: imgEl.y, width: imgEl.width, height: imgEl.height }
        : null,
    };
  }, before.id);

  assert(result.newId, 'copyForeign returned no element id');
  assert(
    result.copy && result.imgEl,
    'copy or moved image element missing from the scene',
  );
  const imgEl = result.imgEl as {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  const copy = result.copy as {
    x: number;
    y: number;
    width: number;
    height: number;
  };

  const row = before.row;
  const expectedRect = fromFraction(row, imgEl);
  const copyFraction = toFraction(copy, imgEl);

  assert(
    close(copyFraction.fx, row.fx, 0.001),
    `fx ${copyFraction.fx} vs row ${row.fx}`,
  );
  assert(
    close(copyFraction.fy, row.fy, 0.001),
    `fy ${copyFraction.fy} vs row ${row.fy}`,
  );
  assert(
    close(copyFraction.fw, row.fw, 0.001),
    `fw ${copyFraction.fw} vs row ${row.fw}`,
  );
  assert(
    close(copyFraction.fh, row.fh, 0.001),
    `fh ${copyFraction.fh} vs row ${row.fh}`,
  );
  assert(
    close(copy.x, expectedRect.x, 0.5),
    `copy.x ${copy.x} vs expected ${expectedRect.x}`,
  );
  assert(
    close(copy.y, expectedRect.y, 0.5),
    `copy.y ${copy.y} vs expected ${expectedRect.y}`,
  );
  console.log(
    `PASS: copyForeign after moveImage — fraction (${copyFraction.fx.toFixed(3)},${copyFraction.fy.toFixed(3)},${copyFraction.fw.toFixed(3)},${copyFraction.fh.toFixed(3)}) rect (${copy.x.toFixed(1)},${copy.y.toFixed(1)}) == fromFraction(row, imageRectNow) (${expectedRect.x.toFixed(1)},${expectedRect.y.toFixed(1)})`,
  );

  // -- a real pointer drag across a foreign region moves nothing ------------
  const target = page
    .locator('[data-testid="foreign-shape"][data-foreign-kind="region"]')
    .first();
  const box = await target.boundingBox();
  assert(box, 'no foreign region shape found on screen');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  const imgBefore = await page.evaluate(() =>
    window.__digsite
      .getElements()
      // biome-ignore lint/suspicious/noExplicitAny: page.evaluate crosses the browser boundary
      .filter((e: any) => e.customData?.kind === 'image')
      // biome-ignore lint/suspicious/noExplicitAny: page.evaluate crosses the browser boundary
      .map((e: any) => ({ id: e.customData.imageId, x: e.x, y: e.y })),
  );

  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 30, cy + 20, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(200);

  const imgAfter = await page.evaluate(() =>
    window.__digsite
      .getElements()
      // biome-ignore lint/suspicious/noExplicitAny: page.evaluate crosses the browser boundary
      .filter((e: any) => e.customData?.kind === 'image')
      // biome-ignore lint/suspicious/noExplicitAny: page.evaluate crosses the browser boundary
      .map((e: any) => ({ id: e.customData.imageId, x: e.x, y: e.y })),
  );
  assert(
    JSON.stringify(imgBefore) === JSON.stringify(imgAfter),
    'an image moved under a foreign-shape drag',
  );

  const selectedKind = await page.evaluate(
    () => window.__digsite.getSelected()?.kind ?? null,
  );
  assert(
    selectedKind === 'foreign',
    `getSelected().kind was ${selectedKind}, expected 'foreign'`,
  );
  console.log(
    'PASS: pointer drag across a foreign region moved nothing; getSelected().kind === "foreign"',
  );

  await page.screenshot({ path: new URL('sheet.png', SCREEN_DIR).pathname });
  console.log('screenshot: sheet.png');

  await browser.close();
  console.log('smoke: all assertions passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
