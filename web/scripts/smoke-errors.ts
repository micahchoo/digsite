// docs/ux/audit.md #1 ("the single most consistent failure, hit 5x across
// every user tested"): a board, sheet or group the viewer cannot see, or
// that does not exist, used to hang on bare "loading…" forever — no page
// ever resolved to an error state. Fixed by catching every page-level fetch
// (Board.tsx, Sheet.tsx, Group.tsx) and rendering the shared `ErrorState`
// component (`web/src/components/ErrorState.tsx`) instead. This script
// drives the real pages against the stub and asserts each one resolves —
// never "loading…" — with the right status.
import { chromium } from 'playwright';

const WEB = process.env.WEB_ORIGIN ?? 'http://localhost:5180';

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${message}`);
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1200, height: 800 },
  });

  await page.goto(WEB);
  await page.getByTestId('email').fill('owner@example.test');
  await page.getByTestId('password').fill('password1');
  await page.getByTestId('submit').click();
  await page.waitForURL(/\/groups$/);
  console.log('signed in');

  async function errorStateText(url: string): Promise<string> {
    await page.goto(`${WEB}${url}`);
    await page.waitForSelector('[data-testid="error-state"]', {
      timeout: 10_000,
    });
    // Never left on "loading…" — the selector above already proves a
    // resolved page, but also check the literal string is gone in case
    // some OTHER "loading…" node is still in the tree beside it.
    const bodyText = await page.locator('body').innerText();
    assert(
      !/^loading…$/m.test(bodyText.trim()),
      `${url}: still shows a bare "loading…" alongside the error state`,
    );
    return page.getByTestId('error-state').innerText();
  }

  // -- 1. nonexistent board id: 404 ------------------------------------------
  const boardMissing = await errorStateText('/b/board-does-not-exist');
  assert(
    /doesn't exist/i.test(boardMissing),
    `nonexistent board: expected a 404-ish message, got: ${boardMissing}`,
  );
  console.log(
    'PASS: nonexistent board resolves to a 404 ErrorState, not infinite loading',
  );

  // -- 2. private board owner is not on the allowlist for: 403 --------------
  // b2 ("Finds") deliberately excludes `owner` from its allowlist
  // (web/stub/server.ts: "an owner not on a private board's allowlist is
  // denied" — ../.claude/rules/access-one-function-per-intent.md).
  const boardDenied = await errorStateText('/b/b2');
  assert(
    /not on this board's list/i.test(boardDenied),
    `denied board: expected the 403 "not on this board's list" copy, got: ${boardDenied}`,
  );
  assert(
    /reason:/i.test(boardDenied),
    `denied board: expected the server's own reason surfaced, got: ${boardDenied}`,
  );
  console.log(
    'PASS: private board not on the allowlist resolves to a 403 ErrorState with the server reason',
  );

  // -- 3. a group the viewer is not a member of: the page-level 403, forms
  // hidden. The stub answers every `/groups/:id/*` route for its one
  // hardcoded group regardless of the id in the URL (never 404s a garbage
  // id), so a truly nonexistent id cannot be reproduced against it — this
  // exercises the SAME `pageError` wiring in Group.tsx via a real denial
  // instead: `outsider@example.test` is signed in but not a member of the
  // group at all (web/stub/server.ts's `GROUP_ROLE` has no entry for it).
  await page.getByRole('button', { name: 'sign out' }).click();
  await page.waitForURL(/\/$/);
  await page.getByTestId('email').fill('outsider@example.test');
  await page.getByTestId('password').fill('password1');
  await page.getByTestId('submit').click();
  await page.waitForURL(/\/groups$/);

  const groupDenied = await errorStateText('/g/g1');
  assert(
    /not on this group's list/i.test(groupDenied),
    `non-member group: expected the 403 "not on this group's list" copy, got: ${groupDenied}`,
  );
  // The old bug: a real error banner AND full working-looking "create a
  // board" / "invite" forms rendered underneath it. Confirm those forms
  // are entirely gone from the page, not just visually below a banner.
  const hasBoardForm = await page.getByTestId('board-name').count();
  assert(
    hasBoardForm === 0,
    'non-member group: the "create a board" form is still in the DOM',
  );
  console.log(
    'PASS: a group the viewer is not a member of hides every action form behind the ErrorState',
  );

  // Back to `owner` for the rest of the script.
  await page.getByRole('button', { name: 'sign out' }).click();
  await page.waitForURL(/\/$/);
  await page.getByTestId('email').fill('owner@example.test');
  await page.getByTestId('password').fill('password1');
  await page.getByTestId('submit').click();
  await page.waitForURL(/\/groups$/);

  // -- 4. nonexistent sheet id: the socket's join-denied becomes a 404 ------
  const sheetMissing = await errorStateText('/s/sheet-does-not-exist');
  assert(
    /doesn't exist/i.test(sheetMissing),
    `nonexistent sheet: expected a 404-ish message, got: ${sheetMissing}`,
  );
  assert(
    !/join denied/i.test(sheetMissing),
    `nonexistent sheet: still shows raw "join denied" jargon: ${sheetMissing}`,
  );
  console.log(
    'PASS: nonexistent sheet resolves to a 404 ErrorState instead of "join denied: ..."',
  );

  await browser.close();
  console.log('smoke-errors: all assertions passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
