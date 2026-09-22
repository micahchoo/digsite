// docs/ux/audit.md #7 (client side): the invite form used to send
// `email: ''` for a blank field and let a malformed address reach the
// server untouched — both 500 on the real server ("Internal Server Error"
// queued for the server agent, see this repo's report back to the lead).
// This script proves the CLIENT half: a malformed address never reaches
// the server at all, and a blank one omits the `email` key rather than
// sending an empty string.
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

  const inviteRequests: unknown[] = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && /\/groups\/[^/]+\/invite$/.test(req.url())) {
      inviteRequests.push(JSON.parse(req.postData() ?? '{}'));
    }
  });

  await page.goto(WEB);
  await page.getByTestId('email').fill('owner@example.test');
  await page.getByTestId('password').fill('password1');
  await page.getByTestId('submit').click();
  await page.waitForURL(/\/groups$/);
  console.log('signed in');

  await page.goto(`${WEB}/g/g1`);
  await page.waitForSelector('[data-testid="invite-email"]');

  // -- 1. a malformed address is caught client-side, never reaches the server -
  await page.fill('[data-testid="invite-email"]', 'not-an-email');
  await page.click('[data-testid="invite-send"]');
  await page.waitForTimeout(300);
  assert(
    inviteRequests.length === 0,
    `a malformed email must never reach POST /invite, but it was called ${inviteRequests.length} time(s)`,
  );
  const validationError = await page.locator('.error').first().innerText();
  assert(
    /doesn't look like an email/i.test(validationError),
    `expected an inline validation message, got: ${validationError}`,
  );
  console.log(
    'PASS: a malformed email is rejected client-side, before any request',
  );

  // -- 2. a blank email omits the key entirely (not `email: ''`) ------------
  await page.fill('[data-testid="invite-email"]', '');
  await page.click('[data-testid="invite-send"]');
  await page.waitForSelector('[data-testid="invite-url"]');
  const countAfterBlank: number = inviteRequests.length;
  assert(
    countAfterBlank === 1,
    `expected exactly one POST /invite for the blank-email send, got ${countAfterBlank}`,
  );
  assert(
    !('email' in (inviteRequests[0] as object)),
    `a blank invite must omit "email" entirely, got body ${JSON.stringify(inviteRequests[0])}`,
  );
  console.log(
    'PASS: a blank email omits the "email" key instead of sending email: \'\'',
  );

  // -- 3. a well-formed address sends normally -------------------------------
  await page.fill('[data-testid="invite-email"]', 'new-teammate@example.test');
  await page.click('[data-testid="invite-send"]');
  await page.waitForTimeout(300);
  const last = inviteRequests.at(-1) as { email?: string };
  assert(
    last?.email === 'new-teammate@example.test',
    `expected the well-formed email to be sent as-is, got ${JSON.stringify(last)}`,
  );
  console.log('PASS: a well-formed email is sent normally');

  await browser.close();
  console.log('smoke-invite: all assertions passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
