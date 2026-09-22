// Owner, 1440x900 — the deep walk: sign-in, groups, group, board
// (zoom/sort/hover/select/detail/explore), sheet (both canvases, draw a
// region + edge on a ux-audit-* sheet), join, error cases.
import { IDS, VIEWPORTS, WEB, newCtx, openBrowser, settle, shot, signIn } from './lib.ts';

const log: string[] = [];
function note(s: string) {
  console.log('NOTE:', s);
  log.push(s);
}

type Box = { x: number; y: number; width: number; height: number };

/** The board's image row is a thin strip whose exact y depends on fit/zoom
 * state, so scan for it via the real click pipeline (`click-info`'s
 * "rank N toggled" vs "rank N — empty") rather than guessing pixels. Each
 * miss toggles nothing. Returns the first successful (x,y) and clears. */
async function findRowAndSelect(page: any, canvasBox: Box, count = 2) {
  const xFracs = [0.35, 0.4, 0.3, 0.45, 0.25, 0.5, 0.2, 0.55, 0.15, 0.6];
  const yFracs = [0.5, 0.55, 0.45, 0.6, 0.4, 0.65, 0.35, 0.7, 0.3];
  let hitY: number | null = null;
  let hits = 0;
  outer: for (const yf of yFracs) {
    for (const xf of xFracs) {
      const cx = canvasBox.x + canvasBox.width * xf;
      const cy = canvasBox.y + canvasBox.height * yf;
      await page.mouse.click(cx, cy);
      await page.waitForTimeout(120);
      const text = (await page.locator('[data-testid="click-info"]').textContent().catch(() => '')) ?? '';
      if (text.includes('toggled')) {
        hitY = cy;
        hits++;
        if (hits >= count) break outer;
      }
    }
  }
  return { hitY, hits };
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
  const ctx = await newCtx(browser, VIEWPORTS.desktop);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => note(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') note(`console.error: ${m.text()}`);
  });

  let inviteUrl: string | null = null;
  let sheetId = '';

  await section('sign-in', async () => {
    await page.goto(`${WEB}/`);
    await shot(page, 'signin-empty');
    await page.fill('[data-testid="email"]', 'owner@example.test');
    await page.fill('[data-testid="password"]', 'wrong-password');
    await page.click('[data-testid="submit"]');
    await settle(page, 600);
    await shot(page, 'signin-error');
    await page.fill('[data-testid="password"]', '');
    await page.fill('[data-testid="password"]', 'password1');
    await page.click('[data-testid="submit"]');
    await page.waitForURL(/\/groups/, { timeout: 10000 });
    await settle(page);
    await shot(page, 'groups-owner');
  });

  await section('group page + invite (empty email -> 500)', async () => {
    await page.goto(`${WEB}/g/${IDS.labGroup}`);
    await settle(page, 600);
    await shot(page, 'group-lab-owner');
    await page.click('[data-testid="invite-send"]');
    await settle(page, 700);
    await shot(page, 'group-lab-invite-empty-email-error');
  });

  const inviteEmail = `ux-audit-invite-${Date.now()}@example.test`;
  await section('group page invite (fresh email -> works)', async () => {
    await page.fill('[data-testid="invite-email"]', inviteEmail);
    await page.click('[data-testid="invite-send"]');
    await settle(page, 700);
    await shot(page, 'group-lab-invite-created');
    inviteUrl = await page.getAttribute('[data-testid="invite-url"]', 'value');
    note(`invite url: ${inviteUrl}`);
    // pending list + copy button state
    await page.click('[data-testid="invite-copy"]');
    await settle(page, 300);
    await shot(page, 'group-lab-invite-copied');
  });

  await section('group page invite (repeat email -> 500)', async () => {
    await page.fill('[data-testid="invite-email"]', inviteEmail);
    await page.click('[data-testid="invite-send"]');
    await settle(page, 700);
    await shot(page, 'group-lab-invite-repeat-email-error');
  });

  let canvasBox: { x: number; y: number; width: number; height: number } | null = null;

  await section('board Field: initial + zoom', async () => {
    await page.goto(`${WEB}/b/${IDS.field}`);
    await settle(page, 1200);
    await shot(page, 'board-field-initial');
    await page.evaluate(() => (window as any).__digsiteBoard?.setZoom(-1));
    await settle(page, 500);
    await shot(page, 'board-field-zoom-in');
    await page.evaluate(() => (window as any).__digsiteBoard?.setZoom(-4.5));
    await settle(page, 500);
    await shot(page, 'board-field-zoom-out');
    await page.evaluate(() => (window as any).__digsiteBoard?.setZoom(-2));
    await settle(page, 500);
  });

  await section('board Field: sort', async () => {
    const sortSelect = page.locator('[data-testid="sort-key"]');
    const optCount = await sortSelect.locator('option').count();
    note(`sort options: ${optCount}`);
    if (optCount > 1) {
      await sortSelect.selectOption({ index: 1 });
      await settle(page, 500);
    }
    await page.click('[data-testid="sort-dir"]');
    await settle(page, 500);
    await shot(page, 'board-field-sorted');
  });

  let rowY: number | null = null;

  await section('board Field: hover + select', async () => {
    canvasBox = await page.locator('canvas').first().boundingBox();
    if (!canvasBox) throw new Error('no canvas box');
    // select two, via the row-scan helper (real clicks through the real
    // pointer pipeline; see findRowAndSelect's own comment)
    const { hitY, hits } = await findRowAndSelect(page, canvasBox, 2);
    note(`row scan: hitY=${hitY} hits=${hits}`);
    rowY = hitY;
    await settle(page, 400);
    await shot(page, 'board-field-selected');

    // hover: now that we know the row, move to it and hold
    if (rowY !== null) {
      const cx = canvasBox.x + canvasBox.width * 0.7;
      await page.mouse.move(cx, rowY);
      await settle(page, 400);
      await page.mouse.move(cx + 2, rowY + 1);
      await settle(page, 400);
      await shot(page, 'board-field-hover');
    }
  });

  await section('board Field: detail + explore', async () => {
    const selItem = page.locator('[data-testid="selection-item"]').first();
    if (!(await selItem.count())) throw new Error('no selection item');
    await selItem.click();
    await settle(page, 600);
    await shot(page, 'board-field-detail');
    const exploreGo = page.locator('[data-testid="explore-go"]');
    if (await exploreGo.count()) {
      await exploreGo.click();
      await settle(page, 800);
      await shot(page, 'board-field-explore');
    }
  });

  await section('create ux-audit-draw sheet', async () => {
    // Explore (previous section) REPLACES the board's selection with its
    // neighbourhood result (confirmed: a 2-image selection collapsed to 1
    // after Explore, with no warning — see the audit's findings). Start
    // clean rather than assume anything survived it.
    if (!canvasBox) throw new Error('no canvas box');
    // The pixel-scan proved real click-to-select works (previous section,
    // 2/2 hits, screenshot 013). For this SECOND selection (needed only to
    // seed the ux-audit sheet, after Explore already replaced the first
    // one) use the same debug hook Board.tsx exposes for exactly this, with
    // two explicit distinct ranks — deterministic, no toggle-cancellation
    // race against a rapid double real click.
    await page.evaluate(() => (window as any).__digsiteBoard?.clear());
    await settle(page, 300);
    await page.evaluate(() => (window as any).__digsiteBoard?.select(53));
    await page.evaluate(() => (window as any).__digsiteBoard?.select(55));
    const ranksNow = await page.evaluate(() => (window as any).__digsiteBoard?.getSelection());
    note(`re-select for sheet creation: ranks=${JSON.stringify(ranksNow)}`);
    // wait for selectedRanks -> selectedImages async resolution (Board.tsx's
    // own effect) to actually land 2 rows in the side panel before
    // submitting, rather than a fixed guess.
    for (let i = 0; i < 20; i++) {
      const n = await page.locator('[data-testid="selection-item"]').count();
      if (n >= 2) break;
      await settle(page, 200);
    }
    const finalCount = await page.locator('[data-testid="selection-item"]').count();
    note(`selection-item count before submit: ${finalCount}`);
    await shot(page, 'board-field-reselected-for-sheet');
    await page.fill('[data-testid="sheet-name"]', 'ux-audit-draw');
    await page
      .locator('form')
      .filter({ has: page.locator('[data-testid="sheet-name"]') })
      .getByRole('button', { name: 'new sheet' })
      .click();
    await page.waitForURL(/\/s\//, { timeout: 10000 });
    sheetId = page.url().split('/s/')[1] ?? '';
    note(`ux-audit sheet id: ${sheetId}`);
    await settle(page, 1200);
    await shot(page, 'sheet-uxaudit-initial-excalidraw');
    const totalEls = await page.evaluate(() => (window as any).__digsite?.getElements().length ?? -1);
    note(`sheet total scene elements right after load: ${totalEls}`);
    await page.click('[data-testid="zoom-fit"]');
    await settle(page, 500);
    await shot(page, 'sheet-uxaudit-after-fit');
    const totalElsAfterFit = await page.evaluate(() => (window as any).__digsite?.getElements().length ?? -1);
    note(`sheet total scene elements after fit: ${totalElsAfterFit}`);
    // Diagnostic: server-side GET /sheets/:id confirms 2 images + a
    // non-empty grid-layout snapshot exist. If the client-nav'd page shows
    // 0 elements but a hard reload shows them, the bug is in the
    // client-side-navigation load path (Board.tsx's `navigate()` after
    // creating a sheet), not the server.
    if (totalElsAfterFit === 0) {
      await page.reload();
      await settle(page, 1500);
      const afterReload = await page.evaluate(() => (window as any).__digsite?.getElements().length ?? -1);
      note(`sheet total scene elements after hard reload: ${afterReload}`);
      await shot(page, 'sheet-uxaudit-after-hard-reload');
    }
  });

  await section('sheet: draw region (best-effort drag + guaranteed)', async () => {
    await page.click('[data-testid="zoom-fit"]');
    await settle(page, 300);
    await page.click('[data-testid="tool-region"]');
    await settle(page, 200);
    await shot(page, 'sheet-uxaudit-region-tool-active');
    const sheetCanvasBox = await page.locator('.sheet-canvas-area').boundingBox();
    if (sheetCanvasBox) {
      const x0 = sheetCanvasBox.x + sheetCanvasBox.width * 0.3;
      const y0 = sheetCanvasBox.y + sheetCanvasBox.height * 0.3;
      await page.mouse.move(x0, y0);
      await page.mouse.down();
      await page.mouse.move(x0 + 150, y0 + 120, { steps: 8 });
      await settle(page, 150);
      await shot(page, 'sheet-uxaudit-region-dragging');
      await page.mouse.up();
      await settle(page, 400);
      await shot(page, 'sheet-uxaudit-region-drag-result');
      await page.keyboard.press('Escape');
    }
    // wait for the sheet's own images to actually be in the live scene
    // (async image load) before drawing against them.
    for (let i = 0; i < 25; i++) {
      const n = await page.evaluate(
        () => (window as any).__digsite?.getElements().filter((e: any) => e.customData?.kind === 'image').length ?? 0,
      );
      if (n >= 1) break;
      await settle(page, 200);
    }
    const imgCount = await page.evaluate(
      () => (window as any).__digsite?.getElements().filter((e: any) => e.customData?.kind === 'image').length ?? 0,
    );
    note(`sheet image elements before drawRegion: ${imgCount}`);
    const drawResult = await page.evaluate(() => {
      const els = (window as any).__digsite.getElements();
      const img = els.find((e: any) => e.customData?.kind === 'image' && !e.isDeleted);
      if (!img) return null;
      const x0 = img.x + img.width * 0.1;
      const y0 = img.y + img.height * 0.1;
      const x1 = img.x + img.width * 0.6;
      const y1 = img.y + img.height * 0.6;
      const id = (window as any).__digsite.pointerDraw(x0, y0, x1, y1);
      if (id) (window as any).__digsite.setProperty(id, 'label', 'ux-audit region');
      return { id, imgId: img.customData?.imageId };
    });
    note(`drawRegion result: ${JSON.stringify(drawResult)}`);
    await settle(page, 500);
    await shot(page, 'sheet-uxaudit-region-committed');
  });

  let edgeId: string | null = null;
  await section('sheet: draw edge (best-effort clicks + guaranteed)', async () => {
    await page.click('[data-testid="tool-edge"]');
    await settle(page, 200);
    await shot(page, 'sheet-uxaudit-edge-tool-active');
    for (let i = 0; i < 15; i++) {
      const n = await page.evaluate(
        () => (window as any).__digsite?.getElements().filter((e: any) => e.customData?.kind === 'image').length ?? 0,
      );
      if (n >= 2) break;
      await settle(page, 200);
    }
    const edgeResult = await page.evaluate(() => {
      const els = (window as any).__digsite.getElements();
      const imgs = els.filter((e: any) => e.customData?.kind === 'image' && !e.isDeleted);
      if (imgs.length < 2) return null;
      const a = imgs[0];
      const b = imgs[1];
      const id = (window as any).__digsite.pointerConnect(
        a.x + a.width / 2,
        a.y + a.height / 2,
        b.x + b.width / 2,
        b.y + b.height / 2,
      );
      if (id) (window as any).__digsite.setProperty(id, 'relation', 'ux-audit-relation');
      return { id, count: imgs.length };
    });
    note(`connect result: ${JSON.stringify(edgeResult)}`);
    edgeId = edgeResult?.id ?? null;
    await settle(page, 500);
    await page.click('[data-testid="tool-select"]');
    await settle(page, 200);
    await shot(page, 'sheet-uxaudit-edge-committed');
    if (edgeId) {
      await page.evaluate((id) => (window as any).__digsite.select(id), edgeId);
      await settle(page, 400);
      await shot(page, 'sheet-uxaudit-inspector-edge');
    }
  });

  await section('sheet: native canvas comparison (ux-audit-draw)', async () => {
    if (!sheetId) throw new Error('no sheetId');
    await page.goto(`${WEB}/s/${sheetId}?canvas=native`);
    await settle(page, 1200);
    await shot(page, 'sheet-uxaudit-native-canvas');
  });

  await section('First pass sheet, both canvases', async () => {
    await page.goto(`${WEB}/s/${IDS.firstPass}`);
    await settle(page, 1200);
    await shot(page, 'sheet-firstpass-excalidraw');
    await page.goto(`${WEB}/s/${IDS.firstPass}?canvas=native`);
    await settle(page, 1200);
    await shot(page, 'sheet-firstpass-native');
  });

  await section('Synthetic 1M board', async () => {
    await page.goto(`${WEB}/b/${IDS.synthetic1m}`);
    await settle(page, 3000);
    await shot(page, 'board-synthetic1m-initial');
    await page.evaluate(() => (window as any).__digsiteBoard?.setZoom(-5));
    await settle(page, 1500);
    await shot(page, 'board-synthetic1m-zoomed-out');
  });

  await section('Finds board (owner has access)', async () => {
    await page.goto(`${WEB}/b/${IDS.finds}`);
    await settle(page, 1000);
    await shot(page, 'board-finds-owner');
  });

  await section('join page, signed out, real invite', async () => {
    if (!inviteUrl) throw new Error('no invite url');
    const ctx2 = await newCtx(browser, VIEWPORTS.desktop);
    const page2 = await ctx2.newPage();
    await page2.goto(inviteUrl);
    await settle(page2, 800);
    await shot(page2, 'join-open-signedout');
    await ctx2.close();
  });

  await section('error: nonexistent board id', async () => {
    await page.goto(`${WEB}/b/00000000-0000-0000-0000-000000000000`);
    await settle(page, 2000);
    await shot(page, 'error-board-nonexistent-owner');
  });

  await section('error: nonexistent group id', async () => {
    await page.goto(`${WEB}/g/00000000-0000-0000-0000-000000000000`);
    await settle(page, 1000);
    await shot(page, 'error-group-nonexistent-owner');
  });

  await section('error: nonexistent sheet id', async () => {
    await page.goto(`${WEB}/s/00000000-0000-0000-0000-000000000000`);
    await settle(page, 2000);
    await shot(page, 'error-sheet-nonexistent-owner');
  });

  await section('error: join not found', async () => {
    const ctx3 = await newCtx(browser, VIEWPORTS.desktop);
    const page3 = await ctx3.newPage();
    await page3.goto(`${WEB}/join/not-a-real-invitation-id`);
    await settle(page3, 800);
    await shot(page3, 'join-not-found');
    await ctx3.close();
  });

  await ctx.close();
  await browser.close();
  console.log('--- NOTES ---');
  console.log(log.join('\n'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
