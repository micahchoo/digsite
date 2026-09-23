// A real bulk import, measured: one browser selection of every image in a
// folder, through the product's upload queue, into a server this script does
// not start. It records the timeline, not a verdict — docs/roadmap.md asks
// for timing, memory and failure tracking of a 20,000-photo import.
//
//   IMPORT_DIR=<folder> SERVER_PID=<pid> DB_NAME=<db> OUT_DIR=<dir> \
//   SERVER_ORIGIN=... WEB_ORIGIN=... bun run src/import-real.ts
//
// Every SAMPLE_MS it writes one JSON line: the UI's own counts, the
// database's counts by image status and job state, the server's RSS and
// high-water mark, the browser's summed RSS and the page's JS heap.
// It stops when the database accounts for every file, when nothing moved
// for STALL_MS, or at TIMEOUT_MS. Nothing is deleted: the board stays for
// the compact-grid retest.
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { SERVER, WEB, signIn } from './session.ts';

const IMPORT_DIR = required('IMPORT_DIR');
const SERVER_PID = Number(required('SERVER_PID'));
const DB_NAME = required('DB_NAME');
const OUT_DIR = required('OUT_DIR');
const PG_CONTAINER = 'digsite-db';
const SAMPLE_MS = Number(process.env.SAMPLE_MS ?? 2_000);
const STALL_MS = Number(process.env.STALL_MS ?? 10 * 60_000);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 4 * 60 * 60_000);
const LIMIT = Number(process.env.IMPORT_LIMIT ?? Number.POSITIVE_INFINITY);

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const IMAGE = /\.(png|jpe?g|webp|gif)$/i;

function rssKb(pid: number): { rss: number; hwm: number } {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const read = (key: string) =>
      Number(status.match(new RegExp(`${key}:\\s+(\\d+)`))?.[1] ?? 0);
    return { rss: read('VmRSS'), hwm: read('VmHWM') };
  } catch {
    return { rss: 0, hwm: 0 };
  }
}

// Every descendant of this process: Playwright's driver and Chromium's
// browser, GPU, renderer and utility processes.
function descendantsRssKb(root: number): number {
  const children = new Map<number, number[]>();
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      const list = children.get(ppid) ?? [];
      list.push(Number(entry));
      children.set(ppid, list);
    } catch {
      // exited while we looked
    }
  }
  let total = 0;
  const stack = [...(children.get(root) ?? [])];
  while (stack.length) {
    const pid = stack.pop() as number;
    total += rssKb(pid).rss;
    stack.push(...(children.get(pid) ?? []));
  }
  return total;
}

function psql(sql: string): string {
  const res = Bun.spawnSync([
    'docker',
    'exec',
    PG_CONTAINER,
    'psql',
    '-U',
    'digsite',
    '-d',
    DB_NAME,
    '-At',
    '-F',
    '=',
    '-c',
    sql,
  ]);
  if (res.exitCode !== 0) throw new Error(res.stderr.toString());
  return res.stdout.toString().trim();
}

function tally(rows: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of rows.split('\n').filter(Boolean)) {
    const [key, value] = line.split('=');
    out[key ?? ''] = Number(value);
  }
  return out;
}

function parseCounts(text: string | null): Record<string, number> | null {
  if (!text) return null;
  const out: Record<string, number> = {};
  for (const [, n, label] of text.matchAll(/(\d+)\s+([a-z]+)/g)) {
    out[label as string] = Number(n);
  }
  return out;
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const timeline = join(OUT_DIR, 'timeline.jsonl');
  writeFileSync(timeline, '');
  const files = readdirSync(IMPORT_DIR)
    .filter((name) => IMAGE.test(name))
    .sort()
    .slice(0, LIMIT)
    .map((name) => join(IMPORT_DIR, name));
  console.log(`[import] ${files.length} files from ${IMPORT_DIR}`);

  const owner = await signIn('owner@example.test', 'password1234');
  const groups = await owner.get<{ id: string; name: string }[]>('/groups');
  const group = groups.json.find((entry) => entry.name === 'Lab');
  if (!group) throw new Error('seeded Lab missing');
  const created = await owner.post<{ id: string }>(
    `/groups/${group.id}/boards`,
    {
      name: `Image vault import ${files.length}`,
      open: true,
    },
  );
  if (created.status !== 200) throw new Error('board creation failed');
  const boardId = created.json.id;
  console.log(`[import] board ${boardId}`);

  const browser = await chromium.launch();
  const responses: Record<string, number> = {};
  const errors: string[] = [];
  const t0 = Date.now();
  let finish = 'timeout';
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    await context.addCookies([
      {
        name: 'better-auth.session_token',
        value: owner.cookie.split('=').slice(1).join('='),
        url: SERVER,
      },
    ]);
    const page = await context.newPage();
    page.on('response', (response) => {
      const url = response.url();
      if (!url.includes('/images') && !url.includes('/uploads')) return;
      const route = url.includes('/uploads')
        ? 'tus'
        : url.includes('/status')
          ? 'status'
          : 'images';
      const key = `${response.request().method()} ${route} ${response.status()}`;
      responses[key] = (responses[key] ?? 0) + 1;
    });
    page.on('requestfailed', (request) => {
      const key = `${request.method()} failed ${request.failure()?.errorText}`;
      responses[key] = (responses[key] ?? 0) + 1;
    });
    page.on('pageerror', (error) => errors.push(`pageerror ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console ${message.text()}`);
    });
    page.on('crash', () => errors.push('page crashed'));

    await page.goto(`${WEB}/b/${boardId}`);
    const input = page.getByTestId('upload-input');
    await input.waitFor({ state: 'attached' });

    const selectStart = Date.now();
    await input.setInputFiles(files);
    const selectMs = Date.now() - selectStart;
    await page.getByTestId('upload-counts').first().waitFor();
    const feedbackMs = Date.now() - selectStart;
    console.log(
      `[import] setInputFiles ${selectMs} ms, counts visible ${feedbackMs} ms`,
    );

    let lastProgress = Date.now();
    let lastSeen = '';
    const t1 = Date.now();
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, SAMPLE_MS));
      const images = tally(
        psql(
          `SELECT status, count(*) FROM images WHERE board_id='${boardId}' GROUP BY status`,
        ),
      );
      const jobs = tally(
        psql("SELECT kind || ':' || state, count(*) FROM jobs GROUP BY 1"),
      );
      const ui = parseCounts(
        await page
          .getByTestId('upload-counts')
          .first()
          .textContent({ timeout: 5_000 })
          .catch(() => null),
      );
      const heap = await page
        .evaluate(
          () =>
            (performance as unknown as { memory?: { usedJSHeapSize: number } })
              .memory?.usedJSHeapSize ?? 0,
        )
        .catch(() => -1);
      const server = rssKb(SERVER_PID);
      const sample = {
        t: Date.now() - t1,
        ui,
        images,
        jobs,
        serverRssMb: Math.round(server.rss / 1024),
        serverHwmMb: Math.round(server.hwm / 1024),
        browserRssMb: Math.round(descendantsRssKb(process.pid) / 1024),
        pageHeapMb: Math.round(heap / 1048576),
      };
      appendFileSync(timeline, `${JSON.stringify(sample)}\n`);
      const accepted = Object.values(images).reduce((a, b) => a + b, 0);
      const settled = (images.ready ?? 0) + (images.failed ?? 0);
      console.log(
        `[import] ${Math.round(sample.t / 1000)}s accepted=${accepted} ready=${images.ready ?? 0} failed=${images.failed ?? 0} ui=${JSON.stringify(ui)} server=${sample.serverRssMb}MB browser=${sample.browserRssMb}MB heap=${sample.pageHeapMb}MB`,
      );
      const progress = `${accepted}/${settled}`;
      if (progress !== lastSeen) {
        lastProgress = Date.now();
        lastSeen = progress;
      }
      const uiIdle =
        ui !== null &&
        (ui.queued ?? 0) + (ui.uploading ?? 0) + (ui.processing ?? 0) === 0;
      if (settled >= files.length && uiIdle) {
        finish = 'complete';
        break;
      }
      if (uiIdle && accepted === settled && accepted < files.length) {
        finish = 'queue drained short';
        break;
      }
      if (Date.now() - lastProgress > STALL_MS) {
        finish = 'stalled';
        break;
      }
      if (Date.now() - t0 > TIMEOUT_MS) break;
    }
    await page.screenshot({ path: join(OUT_DIR, 'final.png') });
  } finally {
    const failures = psql(
      `SELECT coalesce(error, '(none)'), count(*) FROM images WHERE board_id='${boardId}' AND status='failed' GROUP BY 1`,
    );
    const names = psql(
      `SELECT count(*) || ' rows / ' || count(DISTINCT name) || ' names' FROM images WHERE board_id='${boardId}'`,
    );
    const summary = {
      files: files.length,
      boardId,
      database: DB_NAME,
      finish,
      wallMs: Date.now() - t0,
      rows: names,
      failures: tally(failures),
      responses,
      errors: errors.slice(0, 200),
      errorCount: errors.length,
      serverHwmMb: Math.round(rssKb(SERVER_PID).hwm / 1024),
    };
    writeFileSync(
      join(OUT_DIR, 'summary.json'),
      `${JSON.stringify(summary, null, 2)}\n`,
    );
    console.log(JSON.stringify(summary, null, 2));
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
