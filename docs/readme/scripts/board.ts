// The board take: explore the map, then arrange it and ask it questions.
import { BOARD, WEB, clickOn, glide, glideTo, record, type } from './lib.ts';

await record('board', async (page, mark) => {
  await page.goto(`${WEB}/b/${BOARD}`);
  await page.getByTestId('board-zoom-fit').waitFor();
  await page.waitForTimeout(3500);
  await page.getByTestId('board-zoom-fit').click();
  await page.waitForTimeout(1500);
  await page.mouse.move(1000, 650);
  mark('map');

  // Wander over the map, then zoom into one corner and back out.
  await glide(page, 640, 330, 20);
  await page.waitForTimeout(400);
  await glide(page, 720, 360, 14);
  await page.waitForTimeout(500);
  for (let i = 0; i < 3; i++) {
    await clickOn(page, '[data-testid="board-zoom-in"]');
    await page.waitForTimeout(700);
  }
  await page.waitForTimeout(600);
  await glide(page, 700, 400, 16);
  await page.waitForTimeout(900);
  await glide(page, 820, 420, 16);
  await page.waitForTimeout(800);
  await clickOn(page, '[data-testid="board-zoom-fit"]');
  await page.waitForTimeout(1300);

  // The same pictures, arranged by what they show.
  mark('find');
  await glideTo(page, '[data-testid="sort-key"]');
  await page.waitForTimeout(300);
  await page.getByTestId('sort-key').selectOption({ label: 'Meaning' });
  await page.waitForTimeout(2600);

  // Ask the board a question in words.
  await clickOn(page, '[data-testid="board-find-toggle"]');
  await page.waitForTimeout(400);
  await clickOn(page, '[data-testid="board-find-query"]');
  await type(page, 'amphora');
  await page.waitForTimeout(2500);

  // And one about what is in the picture.
  await clickOn(page, '[data-testid="board-find-mode-meaning"]');
  await page.getByTestId('board-find-query').fill('');
  await clickOn(page, '[data-testid="board-find-query"]');
  await type(page, 'a gold coin with a face');
  await page.waitForTimeout(3500);
});
