// Standalone repro: create-sheet-from-board-selection, then check the
// freshly navigated-to sheet page for scene elements. Observed once
// (owner-desktop run) as an intermittent race: the client-side navigation
// after "new sheet" sometimes lands on a sheet with 0 scene elements
// despite the server holding a valid grid-layout snapshot (confirmed via
// GET /sheets/:id), fixed by a hard reload. Loop a few attempts to catch
// it again with a screenshot.
import { IDS, VIEWPORTS, WEB, newCtx, openBrowser, settle, shot, signIn } from './lib.ts';

async function main() {
  const browser = await openBrowser();
  const ctx = await newCtx(browser, VIEWPORTS.desktop);
  const page = await ctx.newPage();
  await signIn(page, 'owner@example.test');

  for (let attempt = 1; attempt <= 6; attempt++) {
    await page.goto(`${WEB}/b/${IDS.field}`);
    await settle(page, 1000);
    await page.evaluate(() => (window as any).__digsiteBoard?.clear());
    await settle(page, 200);
    // vary the ranks each attempt so each sheet is fresh
    await page.evaluate((n) => (window as any).__digsiteBoard?.select(n), attempt);
    await page.evaluate((n) => (window as any).__digsiteBoard?.select(n + 20), attempt);
    await settle(page, 400);
    await page.fill('[data-testid="sheet-name"]', `ux-audit-repro-${attempt}`);
    await page
      .locator('form')
      .filter({ has: page.locator('[data-testid="sheet-name"]') })
      .getByRole('button', { name: 'new sheet' })
      .click();
    await page.waitForURL(/\/s\//, { timeout: 10000 });
    await settle(page, 900); // deliberately short — same order of magnitude as the original run
    const n = await page.evaluate(() => (window as any).__digsite?.getElements().length ?? -1);
    console.log(`attempt ${attempt}: elements=${n} url=${page.url()}`);
    if (n === 0) {
      await shot(page, `repro-blank-sheet-attempt-${attempt}`);
      // confirm server side is fine
      console.log('  -> reproduced. leaving as-is (no reload) for the screenshot.');
      break;
    }
  }

  await ctx.close();
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
