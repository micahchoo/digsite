// A definition-of-done smoke script for phase 2 section 4 (sheet from a
// neighbourhood) and section 3 (presence), docs/phases/2-sheet.md. Drives
// the running dev server (`bun run dev`) against the stub (`bun run stub`).
// Exits nonzero on any failed assertion.
//
// Self-contained: draws its OWN two edges on sheet "Faces" (s2, which holds
// images 6..17) rather than relying on state another smoke script may have
// left behind, so this passes whether it is run alone or after
// smoke/smoke-board/smoke-draw/smoke-groups in the same stub process.
import { chromium } from 'playwright';

const WEB = process.env.WEB_ORIGIN ?? 'http://localhost:5180';
const SCREEN_DIR = new URL('../screenshots/', import.meta.url);

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${message}`);
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1000 },
  });

  await page.goto(WEB);
  await page.getByTestId('email').fill('owner@example.test');
  await page.getByTestId('password').fill('password1');
  await page.getByTestId('submit').click();
  await page.waitForURL(/\/groups$/);
  console.log('signed in');

  // -- 0. build a known 2-hop chain on sheet "Faces": img-6 -> img-7 -> img-8 -
  await page.goto(`${WEB}/s/s2`);
  await page.waitForFunction(() => typeof window.__digsite !== 'undefined');
  await page.waitForFunction(
    () => window.__digsite.getElements().length > 0,
    undefined,
    { timeout: 10_000 },
  );
  await page.waitForTimeout(500);

  async function imageElId(imageId: string): Promise<string> {
    const found = await page.evaluate(
      (id: string) =>
        window.__digsite.getElements().find(
          // biome-ignore lint/suspicious/noExplicitAny: crosses the browser boundary
          (e: any) =>
            e.customData?.kind === 'image' && e.customData.imageId === id,
        )?.id ?? null,
      imageId,
    );
    assert(found, `no image element for ${imageId} on sheet Faces`);
    return found as string;
  }

  const el6 = await imageElId('img-6');
  const el7 = await imageElId('img-7');
  const el8 = await imageElId('img-8');
  const edge67 = await page.evaluate(
    ([from, to]: [string, string]) =>
      window.__digsite.connect(from, to, 'near', 'forward'),
    [el6, el7] as [string, string],
  );
  const edge78 = await page.evaluate(
    ([from, to]: [string, string]) =>
      window.__digsite.connect(from, to, 'near', 'forward'),
    [el7, el8] as [string, string],
  );
  assert(edge67 && edge78, 'failed to draw the img-6 -> img-7 -> img-8 chain');
  await page.waitForTimeout(500); // 100ms emit debounce + stub apply
  console.log('setup: img-6 -> img-7 -> img-8 chain drawn on sheet Faces');

  // -- 1. explore from img-6, hops=2: selection becomes 3 images -------------
  await page.goto(`${WEB}/b/b1`);
  await page.waitForSelector('canvas');
  await page.waitForFunction(
    () => typeof window.__digsiteBoard !== 'undefined',
  );
  await page.waitForTimeout(300);

  await page.evaluate(() => window.__digsiteBoard?.selectImages(['img-6']));
  await page.waitForSelector('[data-testid="selection-item"]');
  await page.click('[data-testid="selection-item"]');
  await page.waitForSelector('[data-testid="explore-panel"]');
  console.log('PASS: Explore panel opens from the detail panel');

  await page.getByTestId('explore-hops-2').check();
  await page.click('[data-testid="explore-go"]');
  await page.waitForSelector('[data-testid="explore-result"]');
  const resultText = await page
    .locator('[data-testid="explore-result"]')
    .innerText();
  assert(
    resultText.includes('3 images') && resultText.includes('2 edges'),
    `explore result should read 3 images / 2 edges at hops=2, got "${resultText}"`,
  );
  console.log('PASS: explore at hops=2 finds the 3-image, 2-edge chain');

  // docs/ux/audit.md #6: the board already had a 1-image selection
  // (`selectImages(['img-6'])` above) when Explore ran, so it must ASK
  // before replacing it rather than silently overwriting — "Replace" here
  // is that confirm's own affordance, not the old direct side effect.
  await page.waitForSelector('[data-testid="explore-selection-confirm"]');
  const confirmText = await page
    .locator('[data-testid="explore-selection-confirm"]')
    .innerText();
  assert(
    confirmText.includes('1 selected image'),
    `expected the confirm to name the 1 image it would replace, got "${confirmText}"`,
  );
  console.log(
    'PASS: exploring over an existing selection asks before replacing it',
  );
  await page.click('[data-testid="explore-selection-replace"]');

  await page.waitForFunction(
    () => (window.__digsiteBoard?.getSelection().length ?? 0) === 3,
    undefined,
    { timeout: 5000 },
  );
  console.log('PASS: the explore result becomes the map selection (3 ranks)');

  await page.screenshot({ path: new URL('explore.png', SCREEN_DIR).pathname });
  console.log('screenshot: explore.png');

  // -- 1.5. Cancel leaves the selection untouched; Add never shrinks it -----
  // The map selection is now the 3-image chain {img-6, img-7, img-8}.
  // Exploring from img-6 at hops=1 finds the strictly SMALLER neighbourhood
  // {img-6, img-7} (just the one forward edge drawn in setup) — small
  // enough that Replace, Add and Cancel are all distinguishable by the
  // resulting selection size alone.
  await page.click(
    '[data-testid="selection-item"]:has(img[src*="/images/img-6/"])',
  );
  await page.waitForSelector('[data-testid="explore-panel"]');
  await page.getByTestId('explore-hops-1').check();

  await page.click('[data-testid="explore-go"]');
  await page.waitForSelector('[data-testid="explore-selection-confirm"]');
  await page.click('[data-testid="explore-selection-cancel"]');
  await page.waitForSelector('[data-testid="explore-selection-confirm"]', {
    state: 'detached',
  });
  const afterCancel = await page.evaluate(
    () => window.__digsiteBoard?.getSelection().length ?? 0,
  );
  assert(
    afterCancel === 3,
    `Cancel must leave the selection untouched: expected 3, got ${afterCancel}`,
  );
  console.log(
    'PASS: Cancel on the explore confirm leaves the selection untouched',
  );

  await page.click('[data-testid="explore-go"]');
  await page.waitForSelector('[data-testid="explore-selection-confirm"]');
  await page.click('[data-testid="explore-selection-add"]');
  await page.waitForTimeout(300);
  const afterAdd = await page.evaluate(
    () => window.__digsiteBoard?.getSelection().length ?? 0,
  );
  assert(
    afterAdd === 3,
    `Add to selection must never shrink it (union with a subset stays 3): got ${afterAdd}`,
  );
  console.log(
    'PASS: "Add to selection" unions with the current selection instead of replacing it',
  );

  await page.click('[data-testid="explore-go"]');
  await page.waitForSelector('[data-testid="explore-selection-confirm"]');
  await page.click('[data-testid="explore-selection-replace"]');
  await page.waitForFunction(
    () => (window.__digsiteBoard?.getSelection().length ?? 0) === 2,
    undefined,
    { timeout: 5000 },
  );
  console.log(
    'PASS: "Replace" (unlike Add) shrinks the selection to exactly the new neighbourhood',
  );

  // Restore the full 3-image/2-edge result and selection so section 2 below
  // (unchanged from before this block existed) sees exactly what it expects.
  await page.getByTestId('explore-hops-2').check();
  await page.click('[data-testid="explore-go"]');
  await page.waitForSelector('[data-testid="explore-selection-confirm"]');
  await page.click('[data-testid="explore-selection-replace"]');
  await page.waitForFunction(
    () => (window.__digsiteBoard?.getSelection().length ?? 0) === 3,
    undefined,
    { timeout: 5000 },
  );

  // -- 2. new sheet WITHOUT copy connections: no own edges, foreign appears --
  await page.fill('[data-testid="explore-sheet-name"]', 'Explore no-copy');
  await page.click('[data-testid="explore-new-sheet"]');
  await page.waitForURL(/\/s\/s\d+$/);
  await page.waitForFunction(() => typeof window.__digsite !== 'undefined');
  await page.waitForFunction(
    () => window.__digsite.getElements().length > 0,
    undefined,
    { timeout: 10_000 },
  );
  await page.waitForTimeout(300);

  const ownEdgesNoCopy = await page.evaluate(
    () =>
      window.__digsite
        .getElements()
        .filter((e) => e.customData?.kind === 'edge').length,
  );
  assert(
    ownEdgesNoCopy === 0,
    `expected no own edges without copy connections, got ${ownEdgesNoCopy}`,
  );
  console.log('PASS: "New sheet" without copy connections has no own edges');

  await page.waitForFunction(
    () => (window.__digsite.getForeign().length ?? 0) >= 2,
    undefined,
    { timeout: 8000 },
  );
  const foreignKinds = await page.evaluate(() =>
    window.__digsite.getForeign().map((s) => s.kind),
  );
  assert(
    foreignKinds.filter((k) => k === 'edge').length >= 2,
    `expected the 2 chain edges to appear foreign, got kinds [${foreignKinds.join(',')}]`,
  );
  console.log('PASS: the chain edges appear as foreign, not own');

  // -- 3. new sheet WITH copy connections: own edges exist --------------------
  await page.goto(`${WEB}/b/b1`);
  await page.waitForFunction(
    () => typeof window.__digsiteBoard !== 'undefined',
  );
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__digsiteBoard?.selectImages(['img-6']));
  await page.waitForSelector('[data-testid="selection-item"]');
  await page.click('[data-testid="selection-item"]');
  await page.waitForSelector('[data-testid="explore-panel"]');
  await page.getByTestId('explore-hops-2').check();
  await page.click('[data-testid="explore-go"]');
  await page.waitForSelector('[data-testid="explore-result"]');
  await page.check('[data-testid="explore-copy-connections"]');
  await page.fill('[data-testid="explore-sheet-name"]', 'Explore copy');
  await page.click('[data-testid="explore-new-sheet"]');
  await page.waitForURL(/\/s\/s\d+$/);
  await page.waitForFunction(() => typeof window.__digsite !== 'undefined');
  await page.waitForFunction(
    () => window.__digsite.getElements().length > 0,
    undefined,
    { timeout: 10_000 },
  );
  await page.waitForTimeout(500); // the copy-connections effect runs once the scene has loaded

  const ownEdgesCopy = await page.evaluate(() =>
    window.__digsite
      .getElements()
      // biome-ignore lint/suspicious/noExplicitAny: crosses the browser boundary
      .filter((e: any) => e.customData?.kind === 'edge')
      // biome-ignore lint/suspicious/noExplicitAny: crosses the browser boundary
      .map((e: any) => e.customData.relation),
  );
  assert(
    ownEdgesCopy.length === 2 &&
      ownEdgesCopy.every((r: string) => r === 'near'),
    `expected 2 own "near" edges with copy connections, got ${JSON.stringify(ownEdgesCopy)}`,
  );
  console.log('PASS: "New sheet" with copy connections creates own edges');

  const copySheetUrl = page.url();

  // -- 4. presence: a second page's cursor is drawn on the first -------------
  const pageB = await browser.newPage({
    viewport: { width: 1200, height: 800 },
  });
  await pageB.goto(WEB);
  await pageB.getByTestId('email').fill('member@example.test');
  await pageB.getByTestId('password').fill('password1');
  await pageB.getByTestId('submit').click();
  await pageB.waitForURL(/\/groups$/);
  await pageB.goto(copySheetUrl);
  await pageB.waitForFunction(() => typeof window.__digsite !== 'undefined');
  await pageB.waitForTimeout(500);

  const box = await pageB.locator('.digsite-canvas').boundingBox();
  assert(box, 'no .digsite-canvas container on sheet B for the presence move');
  await pageB.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await pageB.mouse.move(
    box.x + box.width / 2 + 40,
    box.y + box.height / 2 + 20,
    {
      steps: 4,
    },
  );

  await page.waitForSelector('[data-testid="peer-cursor"]', { timeout: 5000 });
  const peerName = await page
    .locator('[data-testid="peer-cursor"]')
    .first()
    .getAttribute('data-peer-name');
  assert(
    peerName === 'Member',
    `expected a peer cursor named "Member" on sheet A, got ${JSON.stringify(peerName)}`,
  );
  console.log("PASS: a second page's cursor is drawn on the overlay, named");

  await page.screenshot({ path: new URL('presence.png', SCREEN_DIR).pathname });
  console.log('screenshot: presence.png');

  await pageB.close();
  await browser.close();
  console.log('smoke-explore: all assertions passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
