// Records the README's GIFs from a running digsite. See ../README.md in this
// folder for the whole procedure. Playwright lives under e2e/'s workspace, as
// in docs/ux/scripts/lib.ts.
import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  BrowserContext,
  Page,
} from '../../../e2e/node_modules/playwright/index.d.ts';
import { chromium } from '../../../e2e/node_modules/playwright/index.mjs';

export const WEB = process.env.WEB_ORIGIN ?? 'http://localhost:5180';
// The board load.ts made. Its id is printed when it is made.
export const BOARD = process.env.BOARD ?? '';
if (!BOARD) throw new Error('set BOARD to the id load.ts printed');
export const EMAIL = process.env.EMAIL ?? 'owner@example.test';
export const PASSWORD = process.env.PASSWORD ?? 'password1234';
export const VIEW = { width: 1200, height: 760 };
// Videos and cut lists go here; togif.sh reads them from the same place.
export const TAKES = process.env.TAKES ?? join(tmpdir(), 'digsite-takes');
mkdirSync(TAKES, { recursive: true });

// Headless video draws no pointer. This one follows the real mouse events.
const CURSOR = `
(() => {
  const add = () => {
    if (document.getElementById('rec-cursor')) return;
    const c = document.createElement('div');
    c.id = 'rec-cursor';
    c.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M4 2l15 11-6.5 1.2L16 21l-3 1.4-3.4-7L4 19z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    Object.assign(c.style, { position: 'fixed', left: '-40px', top: '-40px', zIndex: 2147483647, pointerEvents: 'none', transition: 'transform .08s' });
    document.documentElement.appendChild(c);
    const move = (e) => { c.style.left = e.clientX - 3 + 'px'; c.style.top = e.clientY - 2 + 'px'; };
    addEventListener('pointermove', move, true);
    addEventListener('pointerdown', (e) => { move(e); c.style.transform = 'scale(.8)'; }, true);
    addEventListener('pointerup', () => { c.style.transform = ''; }, true);
  };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', add); else add();
})();`;

export async function record(
  name: string,
  body: (page: Page, mark: (segment: string) => void) => Promise<void>,
) {
  const browser = await chromium.launch();
  const auth = await browser.newContext({ viewport: VIEW });
  const ap = await auth.newPage();
  await ap.goto(`${WEB}/`);
  await ap.fill('[data-testid="email"]', EMAIL);
  await ap.fill('[data-testid="password"]', PASSWORD);
  await ap.click('[data-testid="submit"]');
  await ap.waitForURL(/\/groups/);
  const state = await auth.storageState();
  await auth.close();

  const dir = `${TAKES}/video-${name}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir);
  const ctx: BrowserContext = await browser.newContext({
    viewport: VIEW,
    storageState: state,
    recordVideo: { dir, size: VIEW },
    colorScheme: 'light',
  });
  await ctx.addInitScript(CURSOR);
  const page = await ctx.newPage();
  const t0 = Date.now();
  const marks: [string, number][] = [];
  await body(page, (segment) => {
    marks.push([segment, (Date.now() - t0) / 1000]);
  });
  marks.push(['end', (Date.now() - t0) / 1000]);
  await page.waitForTimeout(800);
  await ctx.close();
  await browser.close();
  const file = readdirSync(dir).find((f) => f.endsWith('.webm'));
  if (!file) throw new Error(`no video in ${dir}`);
  renameSync(`${dir}/${file}`, `${TAKES}/${name}.webm`);
  rmSync(dir, { recursive: true });
  // Each segment runs to the next mark; the last one runs to the end.
  for (const [i, [seg, from]] of marks.slice(0, -1).entries()) {
    const to = marks[i + 1]?.[1] ?? from;
    await Bun.write(
      `${TAKES}/${seg}.cut`,
      `${from} ${to - from + 0.6} ${name}`,
    );
    console.log(
      seg,
      'from',
      from.toFixed(1),
      'for',
      (to - from).toFixed(1),
      's',
    );
  }
}

/** The sheet's debug hooks, as far as the takes use them. */
export type SheetElement = {
  id: string;
  x: number;
  y: number;
  isDeleted?: boolean;
  points: [number, number][];
  customData?: { kind?: string };
};
export type SheetWindow = {
  __digsite?: { getElements(): SheetElement[]; select(id: string): void };
  __digsiteSheetDebug: {
    getAppState(): {
      scrollX: number;
      scrollY: number;
      zoom: { value: number };
    };
  };
};

export async function boxOf(page: Page, selector: string) {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`no box for ${selector}`);
  return box;
}

/** Moves the pointer the way a person does: along a path, not in a jump. */
export async function glide(page: Page, x: number, y: number, steps = 18) {
  await page.mouse.move(x, y, { steps });
}
export async function glideTo(page: Page, selector: string, steps = 18) {
  const box = await boxOf(page, selector);
  await glide(page, box.x + box.width / 2, box.y + box.height / 2, steps);
  return box;
}
export async function clickOn(page: Page, selector: string) {
  await glideTo(page, selector);
  await page.waitForTimeout(200);
  await page.locator(selector).first().click();
}
export async function type(page: Page, text: string) {
  await page.keyboard.type(text, { delay: 70 });
}

type Point = { x: number; y: number };

/** Waits until the sheet's scene has elements in it. */
export async function sheetReady(page: Page) {
  await page.waitForFunction(
    () =>
      ((window as unknown as SheetWindow).__digsite?.getElements().length ??
        0) > 0,
  );
}

/** The screen point of a scene point, under the sheet's current camera. */
export async function at(page: Page, sx: number, sy: number): Promise<Point> {
  return page.evaluate(
    ([x, y]) => {
      const s = (
        window as unknown as SheetWindow
      ).__digsiteSheetDebug.getAppState();
      const b = document
        .querySelector('.digsite-canvas')
        ?.getBoundingClientRect() ?? { x: 0, y: 0 };
      return {
        x: b.x + (x + s.scrollX) * s.zoom.value,
        y: b.y + (y + s.scrollY) * s.zoom.value,
      };
    },
    [sx, sy],
  );
}

export async function drag(page: Page, a: Point, b: Point) {
  await glide(page, a.x, a.y);
  await page.waitForTimeout(200);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 20 });
  await page.waitForTimeout(150);
  await page.mouse.up();
}

/**
 * Scrolls the painted cups out from under the floating details panel. The
 * scene coordinates the takes use are where the sheet lays the cups out for
 * load.ts's board.
 */
export async function bringCupsIntoView(page: Page) {
  await glide(page, 640, 450);
  for (let i = 0; i < 9; i++) {
    await page.mouse.wheel(20, 14);
    await page.waitForTimeout(40);
  }
  await page.waitForTimeout(500);
}

/**
 * Selects the sheet's one connection. The pointer goes to the line, but the
 * selection is made through the debug hook: the line is routed, so its bend
 * is not where its stored points say, and a click there misses.
 */
export async function selectConnection(page: Page) {
  const edge = await page.evaluate(() => {
    const e = (window as unknown as SheetWindow).__digsite
      ?.getElements()
      .find((x) => x.customData?.kind === 'edge' && !x.isDeleted);
    if (!e) throw new Error('no connection on the sheet');
    const [px, py] = e.points[Math.floor(e.points.length / 2)] ?? [0, 0];
    return { id: e.id, x: e.x + px, y: e.y + py };
  });
  const m = await at(page, edge.x, edge.y);
  await glide(page, m.x, m.y);
  await page.evaluate(
    (id) => (window as unknown as SheetWindow).__digsite?.select(id),
    edge.id,
  );
}
