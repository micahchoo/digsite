// The sheet take: find the cups, start a sheet from them, mark two painted
// centres and connect them, then compare the two ends. Scene coordinates
// below are the tondi of two cups where the sheet's own layout puts them for
// load.ts's board; a different board needs new ones. props.ts records on the
// sheet this take leaves.
import {
  BOARD,
  WEB,
  at,
  boxOf,
  bringCupsIntoView,
  clickOn,
  drag,
  glide,
  record,
  selectConnection,
  sheetReady,
  type,
} from './lib.ts';

await record('sheet', async (page, mark) => {
  await page.goto(`${WEB}/b/${BOARD}`);
  await page.getByTestId('board-zoom-fit').waitFor();
  await page.waitForTimeout(3500);
  await page.mouse.move(1000, 650);
  mark('start');

  await clickOn(page, '[data-testid="board-find-toggle"]');
  await clickOn(page, '[data-testid="board-find-query"]');
  await type(page, 'kylix');
  await page.getByTestId('board-find-select-matches').waitFor();
  await page.waitForTimeout(1600);
  await clickOn(page, '[data-testid="board-find-select-matches"]');
  await page.waitForTimeout(1400);
  await clickOn(page, '[data-testid="board-tray-start-sheet"]');
  await clickOn(page, '[data-testid="board-tray-sheet-name"]');
  await type(page, 'Drinking cups');
  await page.waitForTimeout(300);
  await clickOn(page, '[data-testid="board-tray-sheet-create"]');
  await page.waitForURL(/\/s\//);
  await sheetReady(page);
  await page.waitForTimeout(2500);
  console.log('sheet', page.url());

  mark('draw');
  await bringCupsIntoView(page);
  // A region on the first cup's painted centre, named.
  await clickOn(page, '[data-testid="tool-region"]');
  await drag(page, await at(page, 752, 428), await at(page, 850, 532));
  await page.getByTestId('region-label-input').waitFor();
  await page.waitForTimeout(300);
  await type(page, 'tondo');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(900);

  // The same on the second; the board's vocabulary offers the word.
  await clickOn(page, '[data-testid="tool-region"]');
  await drag(page, await at(page, 436, 752), await at(page, 526, 874));
  await page.getByTestId('region-label-input').waitFor();
  await page.waitForTimeout(300);
  await type(page, 'ton');
  await page.waitForTimeout(900);
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(300);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(900);

  // Connect the two regions in one gesture, and name the connection.
  await clickOn(page, '[data-testid="tool-select"]');
  const r2 = await at(page, 481, 813);
  await glide(page, r2.x, r2.y);
  await page.mouse.click(r2.x, r2.y);
  await page.waitForTimeout(600);
  const handle = page.getByTestId('connect-handle');
  await handle.waitFor();
  const hb = await boxOf(page, '[data-testid="connect-handle"]');
  await drag(
    page,
    { x: hb.x + hb.width / 2, y: hb.y + hb.height / 2 },
    await at(page, 801, 480),
  );
  await page.getByTestId('relation-picker').waitFor();
  await page.waitForTimeout(400);
  await type(page, 'same painter');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1200);
  // Its details show both ends as evidence.
  await selectConnection(page);
  await page.waitForTimeout(2200);

  mark('compare');
  await clickOn(page, '[data-testid="inspector-compare"]');
  await page.getByTestId('compare').waitFor();
  await page.waitForTimeout(1500);
  await clickOn(page, '[data-testid="compare-mode-swipe"]');
  await page.waitForTimeout(800);
  const d = await boxOf(page, '[data-testid="compare-divider"]');
  const cx = d.x + d.width / 2;
  const cy = d.y + d.height / 2;
  await glide(page, cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx - 180, cy, { steps: 25 });
  await page.mouse.move(cx + 180, cy, { steps: 40 });
  await page.mouse.move(cx, cy, { steps: 20 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  await clickOn(page, '[data-testid="compare-mode-overlay"]');
  await page.waitForTimeout(2000);
});
