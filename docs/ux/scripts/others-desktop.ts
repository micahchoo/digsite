// member / listed / outsider, 1440x900 — lighter walk: sign-in, groups,
// group, board (quick), sheet (both canvases, quick), and the per-user
// error cases (member hits Finds — not on its allowlist; outsider isn't
// even in Lab).
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

async function walkUser(email: string, tag: string) {
  const browser = await openBrowser();
  const ctx = await newCtx(browser, VIEWPORTS.desktop);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => note(`[${tag}] pageerror: ${e.message}`));

  await section(`${tag}: sign-in + groups`, async () => {
    await signIn(page, email);
    await settle(page, 500);
    await shot(page, `${tag}-groups`);
  });

  await section(`${tag}: group Lab`, async () => {
    await page.goto(`${WEB}/g/${IDS.labGroup}`);
    await settle(page, 700);
    await shot(page, `${tag}-group-lab`);
  });

  await section(`${tag}: board Field`, async () => {
    await page.goto(`${WEB}/b/${IDS.field}`);
    await settle(page, 1200);
    await shot(page, `${tag}-board-field`);
    const canvasBox = await page.locator('canvas').first().boundingBox();
    if (canvasBox) {
      // one real click near the known row (see owner-desktop's row scan —
      // same board, same fit math) to show select+detail for this user
      await page.mouse.click(canvasBox.x + canvasBox.width * 0.35, canvasBox.y + canvasBox.height * 0.5);
      await settle(page, 400);
      const item = page.locator('[data-testid="selection-item"]').first();
      if (await item.count()) {
        await item.click();
        await settle(page, 500);
        await shot(page, `${tag}-board-field-detail`);
      } else {
        await shot(page, `${tag}-board-field-select-miss`);
      }
    }
  });

  await section(`${tag}: sheet First pass, both canvases`, async () => {
    await page.goto(`${WEB}/s/${IDS.firstPass}`);
    await settle(page, 1100);
    await shot(page, `${tag}-sheet-firstpass-excalidraw`);
    await page.goto(`${WEB}/s/${IDS.firstPass}?canvas=native`);
    await settle(page, 1100);
    await shot(page, `${tag}-sheet-firstpass-native`);
  });

  await section(`${tag}: private board Finds`, async () => {
    await page.goto(`${WEB}/b/${IDS.finds}`);
    await settle(page, 1500);
    await shot(page, `${tag}-board-finds`);
  });

  await section(`${tag}: nonexistent board id`, async () => {
    await page.goto(`${WEB}/b/00000000-0000-0000-0000-000000000000`);
    await settle(page, 1500);
    await shot(page, `${tag}-error-board-nonexistent`);
  });

  await ctx.close();
  await browser.close();
}

async function main() {
  await walkUser('member@example.test', 'member');
  await walkUser('listed@example.test', 'listed');
  await walkUser('outsider@example.test', 'outsider');
  console.log('--- NOTES ---');
  console.log(log.join('\n'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
