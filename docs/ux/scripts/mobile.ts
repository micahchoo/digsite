// 390x844 — owner (deeper) and member (error case), mobile viewport.
import { IDS, VIEWPORTS, WEB, newCtx, openBrowser, settle, shot, signIn } from './lib.ts';

const log: string[] = [];
function note(s: string) {
  console.log('NOTE:', s);
  log.push(s);
}
async function section(name: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (e) {
    note(`SECTION FAILED (${name}): ${(e as Error).message}`);
  }
}

async function main() {
  const browser = await openBrowser();

  // -- owner, mobile --------------------------------------------------
  const ctx = await newCtx(browser, VIEWPORTS.mobile);
  const page = await ctx.newPage();

  await section('owner mobile: sign-in', async () => {
    await page.goto(`${WEB}/`);
    await shot(page, 'm-signin');
    await signIn(page, 'owner@example.test');
    await settle(page, 500);
    await shot(page, 'm-groups');
  });

  await section('owner mobile: group Lab', async () => {
    await page.goto(`${WEB}/g/${IDS.labGroup}`);
    await settle(page, 700);
    await shot(page, 'm-group-lab');
  });

  await section('owner mobile: board Field', async () => {
    await page.goto(`${WEB}/b/${IDS.field}`);
    await settle(page, 1200);
    await shot(page, 'm-board-field');
    // one real click attempt, row position differs at this width — best effort
    const canvasBox = await page.locator('canvas').first().boundingBox();
    if (canvasBox) {
      for (const yf of [0.5, 0.45, 0.55, 0.4, 0.6]) {
        await page.mouse.click(canvasBox.x + canvasBox.width * 0.4, canvasBox.y + canvasBox.height * yf);
        await settle(page, 150);
        const text = (await page.locator('[data-testid="click-info"]').textContent().catch(() => '')) ?? '';
        if (text.includes('toggled')) break;
      }
      await settle(page, 400);
      await shot(page, 'm-board-field-selected');
    }
  });

  await section('owner mobile: sheet First pass, both canvases', async () => {
    await page.goto(`${WEB}/s/${IDS.firstPass}`);
    await settle(page, 1200);
    await shot(page, 'm-sheet-firstpass-excalidraw');
    await page.goto(`${WEB}/s/${IDS.firstPass}?canvas=native`);
    await settle(page, 1200);
    await shot(page, 'm-sheet-firstpass-native');
  });

  await section('owner mobile: Synthetic 1M', async () => {
    await page.goto(`${WEB}/b/${IDS.synthetic1m}`);
    await settle(page, 2500);
    await shot(page, 'm-board-synthetic1m');
  });

  await section('owner mobile: join page signed out', async () => {
    const ctx2 = await newCtx(browser, VIEWPORTS.mobile);
    const page2 = await ctx2.newPage();
    await page2.goto(`${WEB}/join/not-a-real-invitation-id`);
    await settle(page2, 700);
    await shot(page2, 'm-join-not-found');
    await ctx2.close();
  });

  await ctx.close();

  // -- member, mobile: error cases ------------------------------------
  const ctxM = await newCtx(browser, VIEWPORTS.mobile);
  const pageM = await ctxM.newPage();
  await section('member mobile: private board Finds (denied)', async () => {
    await signIn(pageM, 'member@example.test');
    await pageM.goto(`${WEB}/b/${IDS.finds}`);
    await settle(pageM, 1500);
    await shot(pageM, 'm-member-board-finds-denied');
  });
  await section('member mobile: nonexistent board', async () => {
    await pageM.goto(`${WEB}/b/00000000-0000-0000-0000-000000000000`);
    await settle(pageM, 1500);
    await shot(pageM, 'm-member-error-board-nonexistent');
  });
  await ctxM.close();

  await browser.close();
  console.log('--- NOTES ---');
  console.log(log.join('\n'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
