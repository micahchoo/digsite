import { chromium } from '../../../../e2e/node_modules/playwright/index.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..');

const pages = [
  ['board-shell.html', 'shell-on-board.png'],
  ['board-tray.html', 'board-selection-tray-12.png'],
  ['sheet-inspector.html', 'sheet-with-inspector.png'],
  ['homepage-dig-site.html', 'homepage-dig-site.png'],
  ['homepage-deep-sea.html', 'homepage-deep-sea.png'],
  ['homepage-hot-pink.html', 'homepage-hot-pink.png'],
  ['homepage-terminal.html', 'homepage-terminal.png'],
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

for (const [src, out] of pages) {
  const url = pathToFileURL(join(HERE, src)).href;
  await page.goto(url);
  await page.waitForTimeout(120);
  await page.screenshot({ path: join(OUT, out) });
  console.log('wrote', out);
}

await browser.close();
