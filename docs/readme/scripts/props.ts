// The properties take, on the sheet sheet.ts leaves: a picture's details,
// with a property added, then the connection's — how sure, why, and a
// property of its own.
import { signIn } from '../../../e2e/src/session.ts';
import {
  BOARD,
  EMAIL,
  PASSWORD,
  WEB,
  at,
  bringCupsIntoView,
  clickOn,
  glide,
  record,
  selectConnection,
  sheetReady,
  type,
} from './lib.ts';

const s = await signIn(EMAIL, PASSWORD);
const [sheet] = (await s.get<{ id: string }[]>(`/boards/${BOARD}/sheets`)).json;
if (!sheet) throw new Error('no sheet on the board; run sheet.ts first');

await record('props', async (page, mark) => {
  await page.goto(`${WEB}/s/${sheet.id}`);
  await sheetReady(page);
  await page.waitForTimeout(2500);
  await bringCupsIntoView(page);
  mark('properties');

  // A picture: what the catalogue said, and one thing more.
  const cup = await at(page, 380, 800);
  await glide(page, cup.x, cup.y);
  await page.mouse.click(cup.x, cup.y);
  await page.getByTestId('detail-new-key').waitFor();
  await page.waitForTimeout(1600);
  await clickOn(page, '[data-testid="detail-new-key"]');
  await type(page, 'condition');
  await page.keyboard.press('Enter');
  await clickOn(page, '[data-testid="detail-prop-condition"]');
  await type(page, 'rim repaired');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1600);

  // The connection: how sure, and why it holds.
  await selectConnection(page);
  await page.getByTestId('inspector-confidence').waitFor();
  await page.waitForTimeout(1200);
  await clickOn(page, '[data-testid="inspector-confidence-likely"]');
  await page.waitForTimeout(500);
  await clickOn(page, '[data-testid="inspector-note"]');
  await type(page, 'Same meander border; the drapery falls the same way.');
  await page.waitForTimeout(600);
  const newKey = '.claim-property-add input';
  await clickOn(page, newKey);
  await type(page, 'seen');
  await page.keyboard.press('Enter');
  await clickOn(page, '.claim-property input[id$="-seen"]');
  await type(page, 'both in gallery 151');
  await page.waitForTimeout(2200);
});
