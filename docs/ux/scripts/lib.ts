// Shared helpers for the UX audit walk. Plain Playwright, run with
// `bun run docs/ux/scripts/<name>.ts` from the app/ directory.
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// playwright isn't hoisted to the repo root's node_modules — it lives under
// e2e/'s workspace. Import from there rather than adding a dependency
// anywhere outside docs/ux/ (this audit is read-only on source code).
import type { Browser, BrowserContext, Page } from '../../../e2e/node_modules/playwright/index.d.ts';
import { chromium } from '../../../e2e/node_modules/playwright/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SHOT_DIR = join(HERE, '../screenshots');
mkdirSync(SHOT_DIR, { recursive: true });

export const WEB = 'http://localhost:5180';

export const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
} as const;

export const USERS = {
  owner: 'owner@example.test',
  member: 'member@example.test',
  listed: 'listed@example.test',
  outsider: 'outsider@example.test',
} as const;
export const PASSWORD = 'password1';

// Real ids on the running demo (discovered via API, 2026-09-22).
export const IDS = {
  labGroup: 'yfp797BgtCiRiR9jvOd6p2vZItCnqdwh',
  field: '066c9df6-1e0a-4f56-bb15-c28357e23ed2',
  finds: '32399345-88ee-45b6-bb9e-74479b75a9b6',
  synthetic1m: '25f375ea-4e5e-40c4-b21b-9ad863dbbab1',
  firstPass: 'e9274b48-d700-498d-83a9-f3ee5e990cbe',
  faces: '0bf5d609-6131-4b26-9c3f-d33795ea1b41',
};

let shotN = 0;
export async function shot(page: Page, name: string) {
  shotN += 1;
  const fname = `${String(shotN).padStart(3, '0')}-${name}.png`;
  await page.screenshot({ path: join(SHOT_DIR, fname), fullPage: false });
  console.log('shot:', fname);
  return fname;
}

export async function openBrowser(): Promise<Browser> {
  return chromium.launch();
}

export async function newCtx(
  browser: Browser,
  viewport: { width: number; height: number },
): Promise<BrowserContext> {
  return browser.newContext({ viewport });
}

export async function signIn(page: Page, email: string, password = PASSWORD) {
  await page.goto(`${WEB}/`);
  await page.waitForSelector('[data-testid="email"]', { timeout: 10000 });
  await page.fill('[data-testid="email"]', email);
  await page.fill('[data-testid="password"]', password);
  await page.click('[data-testid="submit"]');
  await page.waitForURL(/\/groups/, { timeout: 10000 });
}

export async function settle(page: Page, ms = 400) {
  await page.waitForTimeout(ms);
}
