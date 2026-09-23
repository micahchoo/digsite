// What "fits a phone" means for a smoke script, in one place: no sideways
// scroll, and a control is on screen whole and on top at its centre, so a
// thumb can reach it. smoke-surfaces.ts and smoke-phone.ts both ask these.
import type { Page } from 'playwright';

export function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${message}`);
}

/** No sideways scroll: the page is never wider than the screen. */
export async function fits(page: Page, what: string) {
  const [scroll, inner] = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    window.innerWidth,
  ]);
  assert(
    scroll <= inner + 1,
    `${what}: page is ${scroll}px wide on a ${inner}px screen`,
  );
}

/** Inside the screen, and the thing itself is on top at its centre. */
export async function reachable(page: Page, testId: string, what: string) {
  const ok = await page
    .getByTestId(testId)
    .first()
    .evaluate((el) => {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) return false;
      // Its whole width on screen: a panel hanging off one side passed a
      // centre-only check (the phone's side drawer, 25 px off the left).
      if (r.left < -1 || r.right > innerWidth + 1) return false;
      const top = document.elementFromPoint(cx, cy);
      return !!top && (top === el || el.contains(top) || top.contains(el));
    });
  assert(ok, `${what}: "${testId}" cannot be reached`);
}
