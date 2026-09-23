// A CSS change that must change nothing, proved: every shell element's
// computed style (and its ::before/::after) on four pages, at three widths,
// light and dark, with the phone's drawers open, written to $SNAPSHOT_OUT.
// With $SNAPSHOT_BASE set it compares against that file instead and fails on
// any difference. Used to merge shell.css's duplicate selectors, 2026-09-23;
// two captures of an unchanged tree differ by nothing, so any difference is
// the change.
//
//   SNAPSHOT_OUT=/tmp/before.json bun run smoke scripts/css-snapshot.ts
//   (edit the CSS)
//   SNAPSHOT_BASE=/tmp/before.json bun run smoke scripts/css-snapshot.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { type Page, chromium } from 'playwright';

const WEB = process.env.WEB_ORIGIN ?? 'http://localhost:5180';
const OUT = process.env.SNAPSHOT_OUT ?? '/tmp/css-snapshot.json';

async function capture(
  page: Page,
): Promise<Record<string, Record<string, string>>> {
  return page.evaluate(() => {
    const out: Record<string, Record<string, string>> = {};
    const all = document.querySelectorAll<HTMLElement>(
      '[class*="shell-"], [class*="shell-"] > svg, [class*="shell-"] > *',
    );
    const seen = new Map<string, number>();
    for (const el of all) {
      const base = `${el.tagName.toLowerCase()}.${[...el.classList].sort().join('.')}`;
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      const cs = getComputedStyle(el);
      const parts: Record<string, string> = {};
      for (const p of Array.from(cs)) parts[p] = cs.getPropertyValue(p);
      for (const pseudo of ['::before', '::after']) {
        const ps = getComputedStyle(el, pseudo);
        if (ps.content && ps.content !== 'none')
          for (const p of Array.from(ps))
            parts[`${pseudo}${p}`] = ps.getPropertyValue(p);
      }
      out[`${base}#${n}`] = parts;
    }
    return out;
  });
}

async function main() {
  const browser = await chromium.launch();
  const result: Record<string, Record<string, Record<string, string>>> = {};
  for (const scheme of ['light', 'dark'] as const)
    for (const width of [1440, 900, 390]) {
      const page = await browser.newPage({
        viewport: { width, height: 900 },
        colorScheme: scheme,
      });
      await page.goto(WEB);
      await page.getByTestId('email').fill('owner@example.test');
      await page.getByTestId('password').fill('password1');
      await page.getByTestId('submit').click();
      await page.waitForURL(/\/groups$/);
      for (const route of ['/groups', '/g/g1', '/b/b1', '/s/s1']) {
        await page.goto(`${WEB}${route}`);
        await page.waitForTimeout(1500);
        result[`${scheme} ${width} ${route}`] = await capture(page);
        if (width === 390) {
          const left = page.getByTestId('shell-hamburger');
          if (await left.isVisible()) {
            await left.click();
            await page.waitForTimeout(400);
            result[`${scheme} ${width} ${route} left`] = await capture(page);
            await page.keyboard.press('Escape');
            await page.waitForTimeout(300);
          }
          const right = page.getByTestId('shell-right-toggle');
          if (await right.isVisible()) {
            await right.click();
            await page.waitForTimeout(400);
            result[`${scheme} ${width} ${route} right`] = await capture(page);
            await page.keyboard.press('Escape');
            await page.waitForTimeout(300);
          }
        }
      }
      await page.close();
    }
  await browser.close();
  const base = process.env.SNAPSHOT_BASE;
  if (!base) {
    writeFileSync(OUT, JSON.stringify(result));
    console.log(`snapshot: ${Object.keys(result).length} views -> ${OUT}`);
    return;
  }
  const before = JSON.parse(readFileSync(base, 'utf8')) as typeof result;
  const differences: string[] = [];
  for (const view of new Set([
    ...Object.keys(before),
    ...Object.keys(result),
  ])) {
    const a = before[view] ?? {};
    const b = result[view] ?? {};
    for (const el of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const pa = a[el] ?? {};
      const pb = b[el] ?? {};
      for (const p of new Set([...Object.keys(pa), ...Object.keys(pb)]))
        if (pa[p] !== pb[p])
          differences.push(`${view} | ${el} | ${p}: ${pa[p]} -> ${pb[p]}`);
    }
  }
  if (differences.length) {
    console.error(differences.slice(0, 20).join('\n'));
    throw new Error(`FAIL: ${differences.length} computed values changed`);
  }
  console.log(
    `PASS: ${Object.keys(result).length} views, no computed value changed`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
