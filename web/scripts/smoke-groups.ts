// A definition-of-done smoke script for the web half of phase 3
// (docs/phases/3-groups.md sections 1-5): the join page, role management,
// allowlist, board/sheet delete with footprint confirmations, and image
// delete's missing placeholder. Drives the running dev server (`bun run
// dev`) against the stub (`bun run stub`). One page, signing in as a
// different fixture user (owner/admin/member/listed/outsider@example.test)
// between scenarios — the stub's session is a cookie keyed by email, so
// re-submitting the sign-in form is enough to switch identity (see
// ../stub/server.ts's header comment on sign-in). Exits nonzero on any
// failed assertion.
import { type Page, chromium } from 'playwright';

const WEB = process.env.WEB_ORIGIN ?? 'http://localhost:5180';
const SERVER = process.env.SERVER_ORIGIN ?? 'http://localhost:8800';
const SCREEN_DIR = new URL('../screenshots/', import.meta.url);

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${message}`);
}

async function signInAs(page: Page, key: string) {
  // A hard navigation, then wait for a DETERMINATE state — either the
  // sign-in form (no session) or a bounce to /groups (a session already
  // exists — sign out first). A snapshot `count()` check here raced the
  // session still loading (SignIn.tsx's redirect fires from a `useEffect`,
  // one tick after mount, so the sign-out button can genuinely be absent
  // for a moment while a session still exists) — that race sent one
  // request through as whichever user was signed in before it, silently.
  await page.goto(WEB);
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="email"]') ||
      location.pathname === '/groups',
  );
  if (page.url().endsWith('/groups')) {
    await page.locator('button:has-text("sign out")').click();
    await page.waitForURL(`${WEB}/`);
    await page.waitForSelector('[data-testid="email"]');
  }
  await page.getByTestId('email').fill(`${key}@example.test`);
  await page.getByTestId('password').fill('password1');
  await page.getByTestId('submit').click();
  await page.waitForURL(/\/groups$/);
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1400, height: 1000 },
  });

  // -- 1. join page: happy path (a brand-new user, signing up inline) -------
  await signInAs(page, 'owner');
  await page.goto(`${WEB}/g/g1`);
  await page.getByTestId('invite-send').click();
  await page.waitForSelector('[data-testid="invite-url"]');
  const inviteUrl = await page.getByTestId('invite-url').inputValue();
  const invitationId = inviteUrl.match(/\/join\/([^/]+)$/)?.[1];
  assert(
    invitationId,
    `could not parse an invitation id out of "${inviteUrl}"`,
  );
  console.log(`PASS: invite created, url shows ${inviteUrl}`);

  // sign out, then follow the link as a signed-out visitor
  await page.locator('button:has-text("sign out")').click();
  await page.waitForURL(`${WEB}/`);
  await page.goto(`${WEB}/join/${invitationId}`);
  await page.waitForSelector('[data-testid="join-status"]');
  const openText = await page.getByTestId('join-status').innerText();
  assert(
    openText.includes('Lab'),
    `join-status "${openText}" does not name the group`,
  );
  assert(
    openText.includes('Owner'),
    `join-status "${openText}" does not name the inviter`,
  );
  console.log(
    `PASS: /join/${invitationId} shows the group and inviter: "${openText}"`,
  );
  await page.screenshot({ path: new URL('join.png', SCREEN_DIR).pathname });
  console.log('screenshot: join.png');

  // outsider@example.test starts in no group (../stub/server.ts's fixture)
  // — sign up right on the join page and land in Lab.
  await page.getByRole('button', { name: 'sign up' }).click();
  await page.getByTestId('name').fill('Outsider');
  await page.getByTestId('email').fill('outsider@example.test');
  await page.getByTestId('password').fill('password1');
  await page.getByTestId('submit').click();
  await page.waitForURL(/\/g\/g1$/);
  await page.waitForSelector('[data-testid="member-list"]');
  const memberListText = await page.getByTestId('member-list').innerText();
  assert(
    memberListText.includes('outsider@example.test'),
    'the group member list does not include the freshly joined outsider',
  );
  console.log(
    'PASS: join accepted, outsider now a member of Lab, landed on /g/g1',
  );

  // -- 1b. a closed invitation shows one message, signed out -----------------
  await page.locator('button:has-text("sign out")').click();
  await page.waitForURL(`${WEB}/`);
  await page.goto(`${WEB}/join/inv-closed`);
  await page.waitForSelector('[data-testid="join-status"]');
  const closedText = await page.getByTestId('join-status').innerText();
  assert(
    closedText === 'This invitation is no longer open.',
    `expected the closed-invitation message, got "${closedText}"`,
  );
  console.log('PASS: a used/expired invitation shows one message');

  // -- 2. role change: allowed as owner, refused as member with the reason --
  await signInAs(page, 'owner');
  await page.goto(`${WEB}/g/g1`);
  await page.waitForSelector('[data-testid="member-list"]');
  await page.selectOption('[data-testid="role-select-u3"]', 'admin'); // member -> admin
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLSelectElement>(
        '[data-testid="role-select-u3"]',
      )?.value === 'admin',
    undefined,
    { timeout: 3000 },
  );
  const ownerRoleError = await page.getByTestId('member-error-u3').innerText();
  assert(
    ownerRoleError === '',
    `owner's role change showed an error: "${ownerRoleError}"`,
  );
  console.log('PASS: owner promoted member (u3) to admin, no error shown');
  await page.screenshot({ path: new URL('members.png', SCREEN_DIR).pathname });
  console.log('screenshot: members.png');

  await signInAs(page, 'listed'); // a plain member — not owner/admin
  await page.goto(`${WEB}/g/g1`);
  await page.waitForSelector('[data-testid="member-list"]');
  await page.selectOption('[data-testid="role-select-u3"]', 'member'); // try to demote back
  await page.waitForSelector('[data-testid="member-error-u3"]:not(:empty)', {
    timeout: 3000,
  });
  const memberRoleError = await page.getByTestId('member-error-u3').innerText();
  assert(
    memberRoleError.includes('owner or admin'),
    `expected a "must be owner or admin" reason inline, got "${memberRoleError}"`,
  );
  console.log(
    `PASS: member's role change refused inline: "${memberRoleError}"`,
  );

  // -- 3. allowlist add/remove on Finds (b2), as its manager (admin) --------
  await signInAs(page, 'admin');
  await page.goto(`${WEB}/b/b2`);
  await page.waitForSelector('[data-testid="allowlist-card"]');
  await page.selectOption('[data-testid="allowlist-add-select"]', {
    label: 'member@example.test',
  });
  await page.getByTestId('allowlist-add').click();
  // The table shows name/role, not email — assert by the row's own testid
  // (member@example.test is u3, see ../stub/server.ts's fixture).
  await page.waitForSelector('[data-testid="allowlist-remove-u3"]', {
    timeout: 3000,
  });
  console.log('PASS: member@example.test added to the Finds allowlist');
  await page.getByTestId('allowlist-remove-u3').click();
  await page.waitForSelector('[data-testid="allowlist-remove-u3"]', {
    state: 'detached',
    timeout: 3000,
  });
  console.log('PASS: member@example.test removed from the Finds allowlist');

  // -- 4. board delete: a fresh, empty board so Field (b1) is untouched -----
  await signInAs(page, 'owner');
  await page.goto(`${WEB}/g/g1`);
  await page.getByTestId('board-name').fill('Scratch');
  await page
    .locator('form:has(input[data-testid="board-name"]) button[type="submit"]')
    .click();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="board-list"]')
        ?.textContent?.includes('Scratch'),
    undefined,
    { timeout: 3000 },
  );
  await page.getByRole('link', { name: 'Scratch' }).click();
  await page.waitForURL(/\/b\//);
  const scratchUrl = page.url();
  const scratchId = scratchUrl.match(/\/b\/([^/]+)$/)?.[1];
  assert(scratchId, `could not read the new board's id from ${scratchUrl}`);
  await page.getByTestId('board-delete').click();
  await page.waitForSelector('[data-testid="board-delete-confirm"]');
  const confirmText = await page
    .getByTestId('board-delete-confirm')
    .innerText();
  assert(
    confirmText.includes('0 images') && confirmText.includes('0 sheets'),
    `board delete confirmation does not show footprint counts: "${confirmText}"`,
  );
  console.log(
    `PASS: board delete confirmation shows counts: "${confirmText.split('\n')[0]}"`,
  );
  await page.screenshot({
    path: new URL('delete-board.png', SCREEN_DIR).pathname,
  });
  console.log('screenshot: delete-board.png');
  await page.getByTestId('board-delete-confirm-confirm').click();
  await page.waitForURL(/\/g\/g1$/);
  const boardListAfter = await page.getByTestId('board-list').innerText();
  assert(
    !boardListAfter.includes('Scratch'),
    'the deleted board is still listed',
  );
  console.log('PASS: the deleted board disappeared from the group page');

  // -- 5. sheet delete shows the foreign-views count -------------------------
  // "Faces" (s2) holds images 8 and 9, which "First pass" (s1) claims —
  // deleting s1 affects exactly one other sheet's foreign view.
  await page.goto(`${WEB}/b/b1`);
  await page.waitForSelector('[data-testid="sheet-list"]');
  await page.getByTestId('sheet-delete-s1').click();
  await page.waitForSelector('[data-testid="sheet-delete-confirm-s1"]');
  const sheetConfirmText = await page
    .getByTestId('sheet-delete-confirm-s1')
    .innerText();
  assert(
    sheetConfirmText.includes('1 other sheet'),
    `expected the foreign-views count in the confirmation, got "${sheetConfirmText}"`,
  );
  console.log(
    `PASS: sheet delete confirmation shows the foreign-views count: "${sheetConfirmText}"`,
  );
  await page.getByTestId('sheet-delete-confirm-s1-confirm').click();
  await page.waitForFunction(
    () =>
      !document
        .querySelector('[data-testid="sheet-list"]')
        ?.textContent?.includes('First pass'),
    undefined,
    { timeout: 3000 },
  );
  console.log('PASS: the deleted sheet disappeared from the board page');

  // -- 6. image delete leaves a missing placeholder --------------------------
  // img-12 is only on "Faces" (s2), never on the now-deleted "First pass".
  const rankedImages = await page.request
    .get(`${SERVER}/boards/b1/images?sort=uploaded_at.desc&from=0&count=100`)
    .then((r) => r.json() as Promise<{ images: { id: string }[] }>);
  const rank = rankedImages.images.findIndex((i) => i.id === 'img-12');
  assert(rank >= 0, 'img-12 not found in the ranked image list');
  await page.waitForFunction(
    () => typeof window.__digsiteBoard !== 'undefined',
  );
  await page.evaluate((r) => window.__digsiteBoard?.select(r), rank);
  await page.waitForSelector('[data-testid="selection-item"]');
  await page.getByTestId('selection-item').first().click();
  await page.waitForSelector('[data-testid="detail-panel"]');
  await page.getByTestId('detail-delete').click();
  await page.getByTestId('detail-delete-confirm').click();
  await page.waitForSelector('[data-testid="detail-panel"]', {
    state: 'detached',
  });
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="selection-item"]')
        ?.textContent?.includes('(missing)'),
    undefined,
    { timeout: 3000 },
  );
  console.log(
    'PASS: the map marks the deleted image missing after a tile refetch',
  );

  // Reload "Faces" (s2) fresh: GET /sheets/:id now reports img-12 missing
  // before any file is fetched, so the original is never requested — the
  // sheet went straight to the placeholder (sheet/Sheet.tsx#loadImages).
  const originalRequests: string[] = [];
  page.on('request', (req) => {
    if (req.url().includes('/images/img-12/original'))
      originalRequests.push(req.url());
  });
  await page.goto(`${WEB}/s/s2`);
  await page.waitForFunction(() => typeof window.__digsite !== 'undefined');
  await page.waitForFunction(
    () => window.__digsite.getElements().length > 0,
    undefined,
    { timeout: 10_000 },
  );
  await page.waitForTimeout(800); // let every file load settle
  const elements = await page.evaluate(() => window.__digsite.getElements());
  const hasImg12 = elements.some(
    // biome-ignore lint/suspicious/noExplicitAny: crosses the browser boundary
    (el: any) => el.customData?.imageId === 'img-12',
  );
  assert(
    hasImg12,
    "the missing image's element is gone from the scene, not just its file",
  );
  assert(
    originalRequests.length === 0,
    `expected no fetch of the missing image's original, got ${originalRequests.length}`,
  );
  console.log(
    "PASS: the sheet never fetched the missing image's original — it loaded the placeholder instead",
  );

  await browser.close();
  console.log('smoke-groups: all assertions passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
