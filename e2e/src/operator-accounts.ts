// Settings › Accounts on the real server: the operator sees every account
// and gives one a new password; the person's old password and session
// stop working and the new one signs in. Anyone else never sees the link.
//
// Run through e2e:fresh with the operator named, e.g.
//   OPERATOR_EMAILS=owner@example.test bun run e2e:fresh src/operator-accounts.ts
import { type Page, chromium } from 'playwright';
import { Session, WEB, signIn } from './session.ts';

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exit(1);
  }
}

async function signInPage(page: Page, email: string, password: string) {
  await page.goto(WEB);
  await page.getByTestId('email').fill(email);
  await page.getByTestId('password').fill(password);
  await page.getByTestId('submit').click();
  await page.waitForURL(/\/groups$/);
}

const NEW_PASSWORD = 'recovered-password-42';

async function main() {
  const outsider = await signIn('outsider@example.test', 'password1234');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await signInPage(page, 'owner@example.test', 'password1234');
    await page.getByTestId('shell-accounts').click();
    await page.waitForSelector('[data-testid="accounts-list"]');
    const listed = await page.getByTestId('accounts-list').innerText();
    assert(
      listed.includes('member@example.test') &&
        listed.includes('outsider@example.test'),
      'the operator sees every account',
    );
    console.log('PASS: 1. the operator opens Accounts and sees every account');

    await page.getByTestId('accounts-reset-outsider@example.test').click();
    await page.getByTestId('accounts-new-password').fill(NEW_PASSWORD);
    await page.getByTestId('accounts-save-password').click();
    await page.waitForSelector('[data-testid="accounts-done"]');
    console.log('PASS: 2. a new password is set from the page');

    const before = await outsider.get('/groups');
    assert(before.status === 401, `old session ended (got ${before.status})`);
    const old = await new Session().post('/api/auth/sign-in/email', {
      email: 'outsider@example.test',
      password: 'password1234',
    });
    assert(old.status === 401, `old password refused (got ${old.status})`);
    await signIn('outsider@example.test', NEW_PASSWORD);
    console.log(
      'PASS: 3. the old session and password stop working; the new one signs in',
    );

    const other = await browser.newPage();
    await signInPage(other, 'member@example.test', 'password1234');
    assert(
      (await other.getByTestId('shell-accounts').count()) === 0,
      'a non-operator has no Accounts link',
    );
    await other.goto(`${WEB}/settings/accounts`);
    await other.waitForSelector('.groups-error');
    console.log(
      'PASS: 4. anyone else has no link, and the page says it is not theirs',
    );
  } finally {
    await browser.close();
  }
  console.log('operator-accounts: all claims passed');
}

await main();
