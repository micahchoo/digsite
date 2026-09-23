// Measures Add images -> native file chooser responsiveness while transfers
// and image processing are active, and guards the board layer from upload
// completion invalidation. Runs against smoke.ts's isolated stub.
import { chromium } from 'playwright';

const WEB = process.env.WEB_ORIGIN ?? 'http://localhost:5180';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  await page.goto(WEB);
  await page.getByTestId('email').fill('owner@example.test');
  await page.getByTestId('password').fill('password1');
  await page.getByTestId('submit').click();
  await page.waitForURL(/\/groups$/);
  let tileRequests = 0;
  let statusResponses = 0;
  let statusReady = 0;
  page.on('response', (response) => {
    if (!new URL(response.url()).pathname.endsWith('/images/status')) return;
    statusResponses += 1;
    void response
      .json()
      .then((body: { images?: { status?: string }[] }) => {
        statusReady +=
          body.images?.filter((image) => image.status === 'ready').length ?? 0;
      })
      .catch(() => {});
  });
  page.on('request', (request) => {
    if (request.url().includes('/boards/b1/tiles/')) tileRequests += 1;
  });
  await page.goto(`${WEB}/b/b1`);
  await page.waitForSelector('canvas');
  await page.waitForFunction(
    () =>
      (
        window as Window & { __digsiteBoard?: { getLayerIds(): string[] } }
      ).__digsiteBoard?.getLayerIds().length,
  );

  const initialLayers = await page.evaluate(() =>
    (
      window as Window & { __digsiteBoard: { getLayerIds(): string[] } }
    ).__digsiteBoard.getLayerIds(),
  );
  await page.waitForFunction(() => {
    const board = (
      window as Window & {
        __digsiteBoard?: { getLayerIds(): string[] };
      }
    ).__digsiteBoard;
    return !!board?.getLayerIds().length;
  });
  await page.waitForTimeout(200);
  const initialTileRequests = tileRequests;
  const canvas = page.locator('canvas');
  let posts = 0;
  let releaseHeld!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseHeld = resolve;
  });
  let heldRequestSeen!: () => void;
  const heldRequest = new Promise<void>((resolve) => {
    heldRequestSeen = resolve;
  });
  let holdTile = false;
  let tileHeldCount = 0;
  const heldTileUrls: string[] = [];
  let releaseTile!: () => void;
  const tileGate = new Promise<void>((resolve) => {
    releaseTile = resolve;
  });
  let heldTileRequestSeen!: () => void;
  const heldTileRequest = new Promise<void>((resolve) => {
    heldTileRequestSeen = resolve;
  });
  await page.route('**/boards/b1/tiles/**', async (route) => {
    if (!holdTile) return route.continue();
    tileHeldCount += 1;
    heldTileUrls.push(route.request().url());
    if (tileHeldCount === 1) heldTileRequestSeen();
    const response = await route.fetch();
    await tileGate;
    await route.fulfill({ response });
  });
  await page.route('**/boards/b1/images*', async (route, request) => {
    if (request.method() !== 'POST') return route.continue();
    if (new URL(request.url()).pathname !== '/boards/b1/images') {
      return route.continue();
    }
    posts += 1;
    const response = await route.fetch();
    if (posts >= 3) {
      if (posts === 3) heldRequestSeen();
      await held;
    }
    await route.fulfill({ response });
  });

  const files = Array.from({ length: 20_000 }, (_, index) => ({
    name: `responsiveness-${index}.png`,
    mimeType: 'image/png',
    buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  }));
  // Hold every tile revalidation that the ready transition causes. This
  // keeps the previous image visible until the replacement response arrives.
  holdTile = true;
  const cameraBeforeUpload = await page.evaluate(() =>
    (
      window as Window & {
        __digsiteBoard: {
          getCamera(): { target: number[]; zoom: number } | null;
        };
      }
    ).__digsiteBoard.getCamera(),
  );
  await page.setInputFiles('[data-testid="upload-input"]', files, {
    timeout: 30_000,
  });
  await Promise.race([
    heldRequest,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error('upload workload did not start')),
        10_000,
      ),
    ),
  ]);
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="upload-counts"]')
        ?.textContent?.includes('20 processing'),
    undefined,
    { timeout: 5_000 },
  );
  const cameraAfterAcceptance = await page.evaluate(() =>
    (
      window as Window & {
        __digsiteBoard: {
          getCamera(): { target: number[]; zoom: number } | null;
        };
      }
    ).__digsiteBoard.getCamera(),
  );
  assert(
    JSON.stringify(cameraBeforeUpload?.target) ===
      JSON.stringify(cameraAfterAcceptance?.target),
    'board count refresh after accepted uploads should keep camera target stable',
  );
  await page.getByRole('button', { name: 'Collapse upload files' }).click();
  assert(
    !(await page.getByTestId('upload-list').isVisible()),
    'the upload file list should collapse while keeping activity controls available',
  );
  assert(
    await page.getByTestId('upload-counts').isVisible(),
    'upload counts should stay visible while the file list is collapsed',
  );
  await page.getByRole('button', { name: 'Show upload files' }).click();
  assert(
    await page.getByTestId('upload-list').isVisible(),
    'the upload file list should expand again',
  );
  await page.getByRole('button', { name: 'Collapse upload files' }).click();
  const cameraBeforePan = await page.evaluate(() =>
    (
      window as Window & {
        __digsiteBoard: {
          getCamera(): { target: number[]; zoom: number } | null;
        };
      }
    ).__digsiteBoard.getCamera(),
  );
  const canvasBox = await canvas.boundingBox();
  assert(canvasBox, 'board canvas should have a visible area');
  await page.mouse.move(
    canvasBox.x + canvasBox.width / 2,
    canvasBox.y + canvasBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    canvasBox.x + canvasBox.width / 2 + 96,
    canvasBox.y + canvasBox.height / 2 + 40,
    { steps: 4 },
  );
  await page.mouse.up();
  const cameraAfterPan = await page.evaluate(() =>
    (
      window as Window & {
        __digsiteBoard: {
          getCamera(): { target: number[]; zoom: number } | null;
        };
      }
    ).__digsiteBoard.getCamera(),
  );
  assert(
    JSON.stringify(cameraBeforePan?.target) !==
      JSON.stringify(cameraAfterPan?.target),
    'the map should pan while uploads are active and the queue is collapsed',
  );
  await page.evaluate(() =>
    (
      window as Window & { __digsiteBoard: { goToRank(rank: number): void } }
    ).__digsiteBoard.goToRank(63),
  );
  let previousTileRequests = tileRequests;
  let stableSince = Date.now();
  while (Date.now() - stableSince < 600) {
    await page.waitForTimeout(50);
    if (tileRequests !== previousTileRequests) {
      previousTileRequests = tileRequests;
      stableSince = Date.now();
    }
  }
  const cameraBeforeRefresh = await page.evaluate(() =>
    (
      window as Window & {
        __digsiteBoard: {
          getCamera(): { target: number[]; zoom: number } | null;
        };
      }
    ).__digsiteBoard.getCamera(),
  );
  const mapClip = {
    x: Math.round(canvasBox.x + canvasBox.width / 2 - 64),
    y: Math.round(canvasBox.y + canvasBox.height / 2 - 64),
    width: 128,
    height: 128,
  };
  await page.mouse.move(1438, 898);
  const canvasBeforeRefresh = await page.screenshot({
    clip: mapClip,
    path: '/tmp/digsite-before-refresh.png',
  });

  const start = Date.now();
  let chooserLatency = -1;
  const chooser = page.waitForEvent('filechooser').then(async (dialog) => {
    chooserLatency = Date.now() - start;
    await dialog.setFiles([]);
  });
  await page.getByTestId('board-upload-button').click();
  await chooser;
  await page.getByTestId('upload-cancel').click();
  await Promise.race([
    heldTileRequest,
    new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              `ready-image tile refresh did not start (status responses=${statusResponses}, ready rows=${statusReady}, tiles=${tileRequests}, held=${tileHeldCount})`,
            ),
          ),
        10_000,
      ),
    ),
  ]);
  const canvasWhileTileHeld = await page.screenshot({
    clip: mapClip,
    path: '/tmp/digsite-while-refresh-held.png',
  });
  const cameraWhileTileHeld = await page.evaluate(() =>
    (
      window as Window & {
        __digsiteBoard: {
          getCamera(): { target: number[]; zoom: number } | null;
        };
      }
    ).__digsiteBoard.getCamera(),
  );
  assert(
    canvasBeforeRefresh.equals(canvasWhileTileHeld),
    'the previous map texture should remain visible while its replacement loads',
  );
  assert(
    JSON.stringify(cameraBeforeRefresh?.target) ===
      JSON.stringify(cameraWhileTileHeld?.target),
    'a tile refresh should not move the camera',
  );
  releaseTile();
  holdTile = false;
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="upload-counts"]')
        ?.textContent?.includes('20 ready'),
    undefined,
    { timeout: 10_000 },
  );
  const tileWaitDeadline = Date.now() + 5_000;
  while (tileRequests <= initialTileRequests && Date.now() < tileWaitDeadline) {
    await page.waitForTimeout(50);
  }
  await page.waitForTimeout(250);
  const canvasAfterReady = await page.screenshot({
    clip: mapClip,
  });
  const finalLayers = await page.evaluate(() =>
    (
      window as Window & { __digsiteBoard: { getLayerIds(): string[] } }
    ).__digsiteBoard.getLayerIds(),
  );
  console.log(
    `active-upload chooser latency=${chooserLatency}ms layers=${JSON.stringify(initialLayers)} -> ${JSON.stringify(finalLayers)} tileRequests=${initialTileRequests} -> ${tileRequests} posts=${posts}`,
  );

  releaseHeld();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="upload-counts"]')
        ?.textContent?.includes('canceled'),
    undefined,
    { timeout: 10_000 },
  );
  assert(chooserLatency < 500, `file chooser took ${chooserLatency}ms to open`);
  const tileLayers = (ids: string[]) =>
    ids.filter((id) => id.startsWith('board-tiles-'));
  assert(
    tileLayers(initialLayers).length === 1 &&
      tileLayers(initialLayers).join('|') === tileLayers(finalLayers).join('|'),
    'upload completion replaced the board tile layer and reloaded the canvas',
  );
  assert(
    tileRequests > initialTileRequests,
    'ready images should trigger fresh tile requests',
  );
  assert(
    !canvasBeforeRefresh.equals(canvasAfterReady),
    'ready image pixels should appear after the replacement tile arrives',
  );
  await browser.close();
  console.log('smoke-board-upload-responsiveness: all assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
