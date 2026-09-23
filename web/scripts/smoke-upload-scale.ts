// Isolated stress repro for large file selections. Holds the first upload
// request so the browser can be measured before the queue completes.
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
  await page.goto(`${WEB}/b/b1`);
  await page.waitForSelector('canvas');

  let activePosts = 0;
  let peakPosts = 0;
  let secondPost!: () => void;
  const secondPostSeen = new Promise<void>((resolve) => {
    secondPost = resolve;
  });
  let releasePosts!: () => void;
  const heldPosts = new Promise<void>((resolve) => {
    releasePosts = resolve;
  });
  let postCount = 0;
  await page.route('**/boards/b1/images*', async (route, request) => {
    if (request.method() !== 'POST') return route.continue();
    activePosts += 1;
    postCount += 1;
    peakPosts = Math.max(peakPosts, activePosts);
    if (postCount >= 2) secondPost();
    await heldPosts;
    activePosts -= 1;
    await route.fulfill({
      status: 413,
      contentType: 'application/json',
      body: JSON.stringify({ reason: 'scale test batch rejected' }),
    });
  });

  function files(prefix: string) {
    return Array.from({ length: 20_000 }, (_, index) => ({
      name: `${prefix}-${index}.png`,
      mimeType: 'image/png',
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    }));
  }
  const started = Date.now();
  await page.evaluate(() => {
    const input = document.querySelector('[data-testid="upload-input"]');
    input?.addEventListener(
      'change',
      () => {
        (window as Window & { __uploadChangeAt?: number }).__uploadChangeAt =
          performance.now();
      },
      { once: true },
    );
  });
  await page.setInputFiles('[data-testid="upload-input"]', files('scale-a'), {
    timeout: 120_000,
  });
  const firstSelectionMs = Date.now() - started;
  await Promise.race([
    secondPostSeen,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error('two upload batches did not start')),
        10_000,
      ),
    ),
  ]);
  await page.waitForSelector('[data-testid="upload-rows"]');
  const firstFeedbackMs = await page.evaluate(
    () =>
      performance.now() -
      ((window as Window & { __uploadChangeAt?: number }).__uploadChangeAt ??
        performance.now()),
  );
  await page.evaluate(() => {
    const input = document.querySelector('[data-testid="upload-input"]');
    input?.addEventListener(
      'change',
      () => {
        (window as Window & { __uploadChangeAt?: number }).__uploadChangeAt =
          performance.now();
      },
      { once: true },
    );
  });
  const secondStarted = Date.now();
  await page.setInputFiles('[data-testid="upload-input"]', files('scale-b'), {
    timeout: 120_000,
  });
  const secondSelectionMs = Date.now() - secondStarted;
  const secondFeedbackMs = await page.evaluate(
    () =>
      performance.now() -
      ((window as Window & { __uploadChangeAt?: number }).__uploadChangeAt ??
        performance.now()),
  );
  const mountedRows = await page.locator('[data-testid="upload-row"]').count();
  const feedbackText = await page
    .locator('[data-testid="upload-counts"]')
    .innerText();
  console.log(
    `two 20k selections: input=${firstSelectionMs}/${secondSelectionMs}ms feedback=${firstFeedbackMs}/${secondFeedbackMs}ms mountedRows=${mountedRows} peakPOSTs=${peakPosts} counts=${JSON.stringify(feedbackText)}`,
  );
  assert(
    mountedRows <= 80,
    `upload queue rendered ${mountedRows} rows; rendering must stay bounded`,
  );
  assert(
    firstFeedbackMs < 1500 && secondFeedbackMs < 1500,
    `queue feedback was delayed (${firstFeedbackMs}ms, ${secondFeedbackMs}ms)`,
  );
  assert(
    feedbackText.includes('39980 queued') &&
      feedbackText.includes('20 uploading'),
    `expected accurate queue counts after two selections, got ${feedbackText}`,
  );
  assert(peakPosts <= 2, `too many concurrent upload requests: ${peakPosts}`);
  await page.getByTestId('shell-group-settings').click();
  await page.waitForURL(/\/g\//);
  assert(
    (await page.getByTestId('global-upload-status').count()) === 1,
    'background upload indicator should remain visible away from the board',
  );
  await page.getByTestId('global-upload-status').locator('summary').click();
  await page
    .getByTestId('global-upload-status')
    .locator('a[href="/b/b1"]')
    .click();
  await page.waitForURL(/\/b\/b1$/);
  assert(
    (await page.locator('[data-testid="upload-row"]').count()) <= 80,
    'returning to the board should restore the bounded upload activity',
  );
  await page.getByTestId('upload-cancel').click();
  await page.waitForFunction(() =>
    document
      .querySelector('[data-testid="upload-counts"]')
      ?.textContent?.includes('39980 canceled'),
  );
  releasePosts();
  await page.waitForFunction(
    () => {
      const counts =
        document.querySelector('[data-testid="upload-counts"]')?.textContent ??
        '';
      return counts.includes('39980 canceled') && counts.includes('20 failed');
    },
    undefined,
    { timeout: 10_000 },
  );
  assert(
    postCount === 2,
    `cancel should stop queued batches; observed ${postCount} POSTs`,
  );
  assert(
    (await page.locator('.board-upload-reason').count()) > 0,
    'a rejected active batch should retain a visible reason',
  );
  console.log(
    'PASS: two 20k selections stay bounded, survive navigation, and cancel without extra uploads',
  );
  await browser.close();
  console.log('smoke-upload-scale: all assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
