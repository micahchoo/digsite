// docs/ux/audit.md #3, adapted from docs/ux/scripts/repro-blank-sheet.ts for
// the stub: a freshly created sheet intermittently loaded with 0 scene
// elements despite the server holding a valid snapshot. Diagnosed cause:
// room.ts's socket 'joined' handler calls `getHandle()?.applyRemote(elements)`
// — the excalidraw adapter's `CanvasHandle.applyRemote` silently no-opped
// when Excalidraw's own imperative API (`apiRef.current`) was not ready yet
// (its own initialisation can outlast ours under load), with no retry. Once
// the socket's single 'joined' payload was dropped, nothing ever re-applied
// it: the scene stayed at 0 elements for the rest of the session. Fixed in
// `ExcalidrawCanvas.tsx` by queueing `applyRemote` calls that arrive before
// the API is ready and replaying them, in order, the moment it exists
// (`readyQueue`).
//
// This script reproduces the ORIGINAL race on purpose — CPU-throttling the
// page (Excalidraw's own init is what has to lose the race) — then loops
// sheet creation 20 times and asserts every one settles to a non-empty
// scene. Against the pre-fix code this fails within a handful of attempts;
// see this file's git history for the before/after counts measured locally.
import { chromium } from 'playwright';

const WEB = process.env.WEB_ORIGIN ?? 'http://localhost:5180';
const ATTEMPTS = 20;
// Deliberately aggressive — this is what makes Excalidraw's own async
// init slow enough to lose the race locally; see ExcalidrawCanvas.tsx's
// readyQueue comment for why the race exists at all.
const CPU_THROTTLE_RATE = 8;
const SETTLE_TIMEOUT_MS = 5000;
const SETTLE_POLL_MS = 100;

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${message}`);
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1400, height: 900 },
  });
  const client = await page.context().newCDPSession(page);

  await page.goto(WEB);
  await page.getByTestId('email').fill('owner@example.test');
  await page.getByTestId('password').fill('password1');
  await page.getByTestId('submit').click();
  await page.waitForURL(/\/groups$/);
  console.log('signed in');

  let everBlank = 0;
  let neverRecovered = 0;

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    await client.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    await page.goto(`${WEB}/b/b1`);
    await page.waitForFunction(
      () => typeof window.__digsiteBoard !== 'undefined',
    );
    await page.waitForTimeout(300);
    await page.evaluate(() => window.__digsiteBoard?.clear());
    await page.evaluate((n) => window.__digsiteBoard?.select(n), attempt);
    await page.evaluate((n) => window.__digsiteBoard?.select(n + 20), attempt);
    await page.waitForTimeout(150);
    // Slice 2: the board's inline "new sheet" form moved into the
    // selection tray (board/Tray.tsx) — "Start a sheet" reveals a
    // name-in-place input, same two-step shape as the old form's own
    // fill-then-submit.
    await page.click('[data-testid="board-tray-start-sheet"]');
    await page.fill(
      '[data-testid="board-tray-sheet-name"]',
      `race-${attempt}-${Date.now()}`,
    );

    // Throttle from the moment the new sheet is created — the window that
    // matters is the socket connecting/joining and Excalidraw initialising
    // on the freshly-navigated sheet page, not the board page beforehand.
    await client.send('Emulation.setCPUThrottlingRate', {
      rate: CPU_THROTTLE_RATE,
    });
    await page.click('[data-testid="board-tray-sheet-create"]');
    await page.waitForURL(/\/s\//, { timeout: 10000 });
    await page.waitForFunction(
      () => typeof window.__digsite !== 'undefined',
      undefined,
      { timeout: 10000 },
    );

    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    let n = await page.evaluate(
      () => window.__digsite?.getElements().length ?? -1,
    );
    const sawBlank = n === 0;
    while (n === 0 && Date.now() < deadline) {
      await page.waitForTimeout(SETTLE_POLL_MS);
      n = await page.evaluate(
        () => window.__digsite?.getElements().length ?? -1,
      );
    }
    await client.send('Emulation.setCPUThrottlingRate', { rate: 1 });

    if (sawBlank) everBlank++;
    console.log(
      `attempt ${attempt}: elements=${n}${sawBlank ? ' (was 0 at first check, then settled)' : ''}`,
    );
    if (n === 0) {
      neverRecovered++;
      console.log(`  FAIL: attempt ${attempt} never left 0 elements`);
    } else {
      assert(n > 0, `attempt ${attempt}: expected a non-empty scene`);
    }
  }

  console.log(
    `\n${ATTEMPTS - neverRecovered}/${ATTEMPTS} settled to a non-empty scene (${everBlank} needed the queued replay to get there)`,
  );
  assert(
    neverRecovered === 0,
    `${neverRecovered}/${ATTEMPTS} sheet loads never recovered from 0 elements — the 'joined' race regressed`,
  );

  await browser.close();
  console.log('smoke-canvas-race: all assertions passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
