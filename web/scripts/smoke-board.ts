import { CELL, COLS } from '@digsite/shared';
// A definition-of-done smoke script for phase 1 section 3 + the web side of
// section 1 (docs/phases/1-map.md): sections, hover, selection, detail,
// upload. Drives the running dev server (`bun run dev`) against the stub
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
    viewport: { width: 1600, height: 900 },
  });

  const tileRequests: string[] = [];
  const sectionRequests: string[] = [];
  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('/tiles/')) tileRequests.push(url);
    if (url.includes('/sections?')) sectionRequests.push(url);
  });

  // -- sign in (the stub accepts any credentials) --------------------------
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
  await page.waitForTimeout(500); // let the first tile batch land

  // -- sections: after a property sort, labels + line markers are drawn ------
  // React StrictMode double-invokes effects in dev, so a sort change can
  // fire a couple of superseded /sections fetches before the real one wins
  // (each guarded by its own `cancelled` closure — see Board.tsx). Against
  // the local stub they all settle within milliseconds; wait for the
  // request count to stop climbing rather than racing the first signal.
  const before = sectionRequests.length;
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
  assert(
    sectionRequests.length > before,
    'no request to /boards/:id/sections after changing sort',
  );
  let settledCount = -1;
  while (settledCount !== sectionRequests.length) {
    settledCount = sectionRequests.length;
    await page.waitForTimeout(150);
  }
  const layerIdsAfterSort = await page.evaluate(
    () => window.__digsiteBoard?.getLayerIds() ?? [],
  );
  assert(
    layerIdsAfterSort.includes('sections-text') &&
      layerIdsAfterSort.includes('sections-line'),
    `expected sections-text and sections-line layers, got ${JSON.stringify(layerIdsAfterSort)}`,
  );
  console.log('PASS: sections route fetched and its layers are drawn');
  await page.screenshot({
    path: new URL('board-sections.png', SCREEN_DIR).pathname,
  });
  console.log('screenshot: board-sections.png');

  // back to the default sort for deterministic hover/selection below
  await page.selectOption(
    '[data-testid="sort-key"]',
    JSON.stringify('uploaded_at'),
  );
  await page.waitForTimeout(300);

  // -- click selects a rank ---------------------------------------------------
  const box = await page.locator('canvas').boundingBox();
  assert(box, 'no canvas bounding box');
  const clickPoint = await page.evaluate(
    ({ cols, cell, rank }) => {
      const camera = window.__digsiteBoard?.getCamera();
      const canvas = document.querySelector('canvas')?.getBoundingClientRect();
      if (!camera || !canvas) return null;
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
    },
    { cols: COLS, cell: CELL, rank: 36 },
  );
  assert(clickPoint, 'could not project a cell center into the board canvas');
  await page.mouse.click(clickPoint.x, clickPoint.y);
  await page.waitForFunction(
    () => (window.__digsiteBoard?.getSelection() ?? []).length > 0,
    undefined,
    { timeout: 3000 },
  );
  const afterClick = await page.evaluate(
    () => window.__digsiteBoard?.getSelection() ?? [],
  );
  assert(
    afterClick.length === 1,
    `expected 1 selected rank, got ${afterClick.length}`,
  );
  const clickedRank = afterClick[0] as number;
  await page.waitForSelector('[data-testid="selection-item"]');
  const itemCountAfterClick = await page
    .locator('[data-testid="selection-item"]')
    .count();
  assert(
    itemCountAfterClick === 1,
    `expected 1 selection-item in the side panel, got ${itemCountAfterClick}`,
  );
  console.log(`PASS: click toggled rank ${clickedRank} into the selection`);

  // -- hover: 150ms still -> a tooltip for the rank under the pointer ---------
  await page.mouse.move(clickPoint.x + 1, clickPoint.y + 1); // nudge so a new hover fires
  await page.mouse.move(clickPoint.x, clickPoint.y);
  await page.waitForSelector('[data-testid="hover-tooltip"]', {
    timeout: 3000,
  });
  const tooltip = page.locator('[data-testid="hover-tooltip"]');
  const tooltipRank = Number(await tooltip.getAttribute('data-rank'));
  const tooltipText = await tooltip.innerText();
  assert(
    tooltipRank === clickedRank,
    `hover tooltip rank ${tooltipRank} does not match the clicked rank ${clickedRank}`,
  );
  const expected = await page.request
    .get(
      `${SERVER}/boards/b1/images?sort=uploaded_at.desc&from=${tooltipRank}&count=1`,
    )
    .then((r) => r.json() as Promise<{ images: { name: string }[] }>);
  const expectedName = expected.images[0]?.name;
  assert(!!expectedName, `no image at rank ${tooltipRank} to compare against`);
  assert(
    tooltipText.includes(expectedName),
    `tooltip text "${tooltipText}" does not contain expected name "${expectedName}"`,
  );
  console.log(
    `PASS: hover tooltip for rank ${tooltipRank} shows "${expectedName}"`,
  );

  // clear the click selection before the shift-drag, for a clean count
  await page.evaluate(() => window.__digsiteBoard?.clear());
  await page.waitForFunction(
    () => (window.__digsiteBoard?.getSelection() ?? []).length === 0,
  );

  // -- shift-drag selects a range, drawn as a PolygonLayer outline -----------
  await page.keyboard.down('Shift');
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.2 + 10, box.y + box.height / 2, {
    steps: 2,
  });
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2, {
    steps: 10,
  });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await page.waitForFunction(
    () => (window.__digsiteBoard?.getSelection() ?? []).length > 1,
    undefined,
    { timeout: 3000 },
  );
  const rangeSelection = await page.evaluate(
    () => window.__digsiteBoard?.getSelection() ?? [],
  );
  assert(
    rangeSelection.length > 1,
    `expected a multi-rank selection from the shift-drag, got ${rangeSelection.length}`,
  );
  const sorted = [...rangeSelection].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) {
    assert(
      sorted[i] === (sorted[i - 1] as number) + 1,
      `selection ${JSON.stringify(sorted)} is not a contiguous rank range`,
    );
  }
  const layerIdsAfterDrag = await page.evaluate(
    () => window.__digsiteBoard?.getLayerIds() ?? [],
  );
  assert(
    layerIdsAfterDrag.includes('selection-outline'),
    `expected a selection-outline layer, got ${JSON.stringify(layerIdsAfterDrag)}`,
  );
  console.log(
    `PASS: shift-drag selected a contiguous range of ${rangeSelection.length} ranks; selection-outline layer present`,
  );
  await page.screenshot({
    path: new URL('board-selection.png', SCREEN_DIR).pathname,
  });
  console.log('screenshot: board-selection.png');

  // -- detail: click a selected image in the side panel, edit a property -----
  await page.locator('[data-testid="selection-item"]').first().click();
  await page.waitForSelector('[data-testid="detail-panel"]');
  const yearInput = page.locator('[data-testid="detail-prop-year"]');
  await yearInput.fill('1809');
  await yearInput.blur();
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="detail-save-state"]')
        ?.textContent === 'Saved',
    undefined,
    { timeout: 3000 },
  );
  const detailImageId = await page.evaluate(() => {
    const panel = document.querySelector('[data-testid="detail-panel"]');
    const img = panel?.querySelector('img');
    return img?.getAttribute('src')?.match(/\/images\/([^/]+)\/original/)?.[1];
  });
  assert(detailImageId, 'could not read the detail panel image id');
  const patched = await page.request
    .get(`${SERVER}/images/${detailImageId}`)
    .then((r) => r.json() as Promise<{ properties: { year?: number } }>);
  assert(
    patched.properties.year === 1809,
    `stub did not echo the patched year, got ${JSON.stringify(patched.properties)}`,
  );
  console.log('PASS: detail panel patched a property; stub echoed 1809');
  await page.screenshot({
    path: new URL('board-detail.png', SCREEN_DIR).pathname,
  });
  console.log('screenshot: board-detail.png');

  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-testid="detail-panel"]', {
    state: 'detached',
  });
  console.log('PASS: Escape closes the detail panel');

  // -- upload: two small files end ready, then tiles refetch -----------------
  const tilesBeforeUpload = tileRequests.length;
  const fileA = {
    name: 'alpha.bin',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from('alpha-file-contents'),
  };
  const fileB = {
    name: 'beta.bin',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from('beta-file-contents'),
  };
  await page.setInputFiles('[data-testid="upload-input"]', [fileA, fileB]);
  await page.waitForSelector('[data-testid="upload-row"]');
  const rowCount = await page.locator('[data-testid="upload-row"]').count();
  assert(rowCount === 2, `expected 2 upload rows, got ${rowCount}`);
  await page.waitForFunction(
    () => {
      const rows = Array.from(
        document.querySelectorAll('[data-testid="upload-row"]'),
      );
      return (
        rows.length === 2 &&
        rows.every((r) => r.getAttribute('data-status') === 'ready')
      );
    },
    undefined,
    { timeout: 15_000 },
  );
  console.log('PASS: both uploaded files reached ready');
  await page.waitForTimeout(500); // let the post-poll tile refetch fire
  assert(
    tileRequests.length > tilesBeforeUpload,
    `expected new /tiles/ requests after upload, had ${tilesBeforeUpload}, now ${tileRequests.length}`,
  );
  console.log(
    `PASS: tiles refetched after upload (${tilesBeforeUpload} -> ${tileRequests.length} /tiles/ requests)`,
  );

  // -- batch progress: reflect accepted images before a later batch finishes,
  // and keep a large upload queue scrollable and readable in dark mode ------
  const countText = await page.locator('.board-count-badge').innerText();
  const countBeforeBatch = Number.parseInt(countText, 10);
  assert(
    Number.isFinite(countBeforeBatch),
    `unexpected board count "${countText}"`,
  );

  let secondBatchStarted!: () => void;
  let releaseSecondBatch!: () => void;
  const secondBatch = new Promise<void>((resolve) => {
    secondBatchStarted = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    releaseSecondBatch = resolve;
  });
  let postBatches = 0;
  await page.route('**/boards/b1/images*', async (route, request) => {
    if (request.method() === 'POST' && ++postBatches === 2) {
      secondBatchStarted();
      await blocked;
    }
    await route.continue();
  });

  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  const manyFiles = Array.from({ length: 12 }, (_, i) => ({
    name: `batch-${i + 1}.bin`,
    mimeType: 'application/octet-stream',
    buffer: Buffer.from(`batch-file-${i + 1}`),
  }));
  await page.setInputFiles('[data-testid="upload-input"]', manyFiles);
  await Promise.race([
    secondBatch,
    page.waitForTimeout(15_000).then(() => {
      throw new Error('second upload batch was not reached');
    }),
  ]);
  await page.waitForFunction(
    (expectedCount: number) => {
      const badge = document.querySelector('.board-count-badge');
      return (
        badge && Number.parseInt(badge.textContent ?? '', 10) === expectedCount
      );
    },
    countBeforeBatch + 10,
    { timeout: 5000 },
  );
  assert(
    await page.locator('[data-testid="board-upload-button"]').isEnabled(),
    'upload action should stay available to add files while a batch is in flight',
  );
  const queueLayout = await page
    .locator('[data-testid="upload-rows"]')
    .evaluate((el) => {
      const queue = el as HTMLElement;
      const list = queue.querySelector('.board-upload-list') as HTMLElement;
      return {
        queueHeight: queue.getBoundingClientRect().height,
        listHeight: list.clientHeight,
        listScrollHeight: list.scrollHeight,
        queueBackground: getComputedStyle(queue).backgroundColor,
        queueForeground: getComputedStyle(queue).color,
        expectedBackground: (() => {
          const probe = document.createElement('span');
          probe.style.backgroundColor = 'var(--surface-raised)';
          document.body.append(probe);
          const color = getComputedStyle(probe).backgroundColor;
          probe.remove();
          return color;
        })(),
      };
    });
  assert(
    queueLayout.queueHeight <= 362,
    `upload queue is unbounded (${queueLayout.queueHeight}px)`,
  );
  assert(
    queueLayout.listScrollHeight > queueLayout.listHeight,
    '12 upload rows should scroll inside the bounded queue',
  );
  assert(
    queueLayout.queueBackground === queueLayout.expectedBackground,
    'upload queue must use the active theme surface token',
  );
  assert(
    queueLayout.queueBackground !== 'rgb(255, 255, 255)',
    'dark upload queue should not use a hard-coded white surface',
  );
  assert(
    queueLayout.queueForeground !== queueLayout.queueBackground,
    'upload text must remain distinct from its surface',
  );
  await page.screenshot({
    path: new URL('board-upload-queue.png', SCREEN_DIR).pathname,
  });
  console.log(
    'PASS: first 10 uploads update the board while batch 2 is held; dark queue is bounded and scrollable',
  );
  releaseSecondBatch();
  await page.waitForFunction(
    () => {
      const rows = Array.from(
        document.querySelectorAll('[data-testid="upload-row"]'),
      );
      return (
        rows.length === 12 &&
        rows.every((r) => r.getAttribute('data-status') === 'ready')
      );
    },
    undefined,
    { timeout: 15_000 },
  );
  await page.waitForFunction(
    (expectedCount: number) => {
      const badge = document.querySelector('.board-count-badge');
      return (
        badge && Number.parseInt(badge.textContent ?? '', 10) === expectedCount
      );
    },
    countBeforeBatch + 12,
    { timeout: 5000 },
  );
  await page.unroute('**/boards/b1/images*');
  await page.locator('[data-testid="upload-close"]').click();
  assert(
    (await page.locator('[data-testid="upload-rows"]').count()) === 0,
    'completed upload activity can be dismissed',
  );
  await page.evaluate(() => {
    delete document.documentElement.dataset.theme;
  });

  // A rejected batch keeps its per-file reason visible in the bounded queue.
  await page.route('**/boards/b1/images*', async (route, request) => {
    if (request.method() === 'POST') {
      await route.fulfill({
        status: 413,
        contentType: 'application/json',
        body: JSON.stringify({ reason: 'test batch rejected' }),
      });
      return;
    }
    await route.continue();
  });
  await page.setInputFiles('[data-testid="upload-input"]', {
    name: 'rejected.bin',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from('rejected-upload'),
  });
  await page.waitForFunction(() => {
    const row = document.querySelector('[data-testid="upload-row"]');
    return row?.getAttribute('data-status') === 'error';
  });
  assert(
    (await page.locator('.board-upload-reason').innerText()).includes(
      'test batch rejected',
    ),
    'failed upload row should show the returned reason',
  );
  assert(
    (await page.locator('[data-testid="upload-counts"]').innerText()).includes(
      '1 failed',
    ),
    'upload queue should summarize failed rows',
  );
  await page.unroute('**/boards/b1/images*');
  await page.locator('[data-testid="upload-close"]').click();
  console.log('PASS: rejected upload shows its reason and failure count');

  // A full disk (507) stops the queue: one request, no retry, and it says why.
  let fullDiskPosts = 0;
  await page.route('**/boards/b1/images*', async (route, request) => {
    if (request.method() === 'POST') {
      fullDiskPosts += 1;
      await route.fulfill({
        status: 507,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'insufficient storage' }),
      });
      return;
    }
    await route.continue();
  });
  await page.setInputFiles(
    '[data-testid="upload-input"]',
    Array.from({ length: 30 }, (_, i) => ({
      name: `full-${i}.png`,
      mimeType: 'image/png',
      buffer: Buffer.from(`full-disk-${i}`),
    })),
  );
  await page.waitForFunction(() =>
    document
      .querySelector('[data-testid="upload-rows"]')
      ?.textContent?.includes('disk is full'),
  );
  // Batches already in flight may land (two at a time); nothing after.
  const inFlight = fullDiskPosts;
  await page.waitForTimeout(2500);
  assert(
    fullDiskPosts === inFlight && fullDiskPosts <= 2,
    `a full disk should send nothing more, but ${fullDiskPosts - inFlight} more requests followed`,
  );
  assert(
    (await page.getByTestId('upload-counts').innerText()).includes('0 queued'),
    'nothing should stay queued behind a full disk',
  );
  await page.unroute('**/boards/b1/images*');
  await page.locator('[data-testid="upload-close"]').click();
  console.log('PASS: a full disk stops the upload queue and says why');

  await browser.close();
  console.log('smoke-board: all assertions passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
