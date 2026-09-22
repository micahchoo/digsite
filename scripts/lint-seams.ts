#!/usr/bin/env bun
// Enforces the seams in .claude/rules/ mechanically. Each check names the
// rule it serves; a failure prints file:line and the rule to read. Runs in
// `bun run check`. Add a check when a rule gains a "must stay true" line
// that a grep can see; never add a suppression comment syntax.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

type Finding = { file: string; line: number; rule: string; message: string };
const findings: Finding[] = [];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'dist' || name === 'data') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

function files(...dirs: string[]): string[] {
  return dirs.flatMap((d) => walk(join(ROOT, d)));
}

function rel(file: string): string {
  return relative(ROOT, file);
}

function forbid(
  rule: string,
  fileList: string[],
  pattern: RegExp,
  message: string,
  allow: (file: string) => boolean = () => false,
): void {
  for (const file of fileList) {
    if (allow(rel(file))) continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, i) => {
      if (pattern.test(text))
        findings.push({ file: rel(file), line: i + 1, rule, message });
    });
  }
}

function requireIn(
  rule: string,
  file: string,
  pattern: RegExp,
  message: string,
): void {
  const full = join(ROOT, file);
  let text = '';
  try {
    text = readFileSync(full, 'utf8');
  } catch {
    findings.push({
      file,
      line: 0,
      rule,
      message: `${message} (file missing)`,
    });
    return;
  }
  if (!pattern.test(text)) findings.push({ file, line: 0, rule, message });
}

// ---------------------------------------------------------------------------
// access-one-function-per-intent: nothing outside access/ reads the plugin's
// membership tables. auth.ts configures the plugin; tests may inspect rows.
{
  const rule = 'access-one-function-per-intent';
  forbid(
    rule,
    files('server/src'),
    /"(member|team|teamMember)"/,
    'reads a membership table outside server/src/access/',
    (f) =>
      f.startsWith('server/src/access/') ||
      f === 'server/src/auth.ts' ||
      f.startsWith('server/src/test/') ||
      f.startsWith('server/src/db/migrations/'),
  );
  // The predicate is written in one place: no route spells "open OR team".
  forbid(
    rule,
    files('server/src'),
    /\.open\s*\|\|/,
    'writes the open-or-allowlist predicate outside access/',
    (f) =>
      f.startsWith('server/src/access/') || f.startsWith('server/src/test/'),
  );
}

// ---------------------------------------------------------------------------
// foreign-never-in-scene: the scene holds no foreign element.
{
  const rule = 'foreign-never-in-scene';
  const sheet = files('web/src/sheet');
  requireIn(
    rule,
    'web/src/sheet/sync.ts',
    /export function isSyncable/,
    'sync.ts must export isSyncable',
  );
  forbid(
    rule,
    [join(ROOT, 'web/src/sheet/sync.ts')],
    /^(?!\s*\/\/).*\bforeign\b/,
    'isSyncable has a foreign clause: something put a foreign claim in the scene',
  );
  // An element literal carrying a foreign marker, or the prototype's id prefix.
  forbid(
    rule,
    sheet,
    /customData\s*:\s*\{[^}]*\bforeign\s*:/,
    'builds an element whose customData carries a foreign marker',
  );
  forbid(
    rule,
    sheet,
    /\bid\s*:\s*['"`]foreign-/,
    "uses the prototype's foreign-<sheet>-<id> element id scheme",
  );
  // Foreign rows are drawn by the overlay only; nothing else may call
  // updateScene with foreign data. Approximation: the word "foreign" and
  // "updateScene" on the same line.
  forbid(
    rule,
    sheet,
    /updateScene[^\n]*foreign|foreign[^\n]*updateScene/,
    'passes foreign data to updateScene',
    (f) => f.includes('/overlay/'),
  );
}

// ---------------------------------------------------------------------------
// ladder-slot-vs-rank: one grid arithmetic, rank tables rebuilt whole,
// unnest JOIN for rank lookups, slots never renumbered.
{
  const rule = 'ladder-slot-vs-rank';
  forbid(
    rule,
    files('server/src', 'web/src', 'shared/src'),
    /\b(const|let|var)\s+(COLS\s*=\s*1024|CELL\s*=\s*128|TILE\s*=\s*256)\b/,
    'redefines a grid constant; import it from @digsite/shared/board/grid',
    (f) => f === 'shared/src/board/grid.ts',
  );
  forbid(
    rule,
    files('server/src'),
    /rank\s*=\s*ANY\s*\(/,
    'rank lookup with = ANY; use unnest($1::int[]) JOIN board_ranks',
  );
  forbid(
    rule,
    files('server/src'),
    /UPDATE\s+board_ranks\b/i,
    'patches a rank table; rebuild it whole',
  );
  forbid(
    rule,
    files('server/src'),
    /UPDATE\s+images\s+SET[^;]*\bslot\s*=/i,
    'renumbers a slot',
  );
  requireIn(
    rule,
    'server/src/boards/ranks.ts',
    /unnest\(\$\d::int\[\]\)/,
    'slotsForTile must use unnest($n::int[]) JOIN',
  );
  // A sortId reaching SQL must have passed parseSortId.
  forbid(
    rule,
    files('server/src'),
    /sort_id\s*=\s*'\$\{/,
    'interpolates a sort id into SQL',
  );
}

// ---------------------------------------------------------------------------
// tile-cache-is-for-the-second-viewer: the headers the measurements read.
{
  const rule = 'tile-cache-is-for-the-second-viewer';
  requireIn(
    rule,
    'server/src/boards/routes.ts',
    /'X-Cache'/,
    'tile responses must carry X-Cache',
  );
  requireIn(
    rule,
    'server/src/boards/routes.ts',
    /'Server-Timing'/,
    'tile responses must carry Server-Timing',
  );
}

// ---------------------------------------------------------------------------
// Every rule's scope must still match a file (CLAUDE.md: prune dead scopes).
{
  const rulesDir = join(ROOT, '.claude/rules');
  for (const name of readdirSync(rulesDir)) {
    if (!name.endsWith('.md')) continue;
    const text = readFileSync(join(rulesDir, name), 'utf8');
    const m = text.match(/^scope:\s*(.+)$/m);
    if (!m) continue;
    const scopes = m[1]
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map((s) => s.trim().replace(/^["']|["']$/g, ''));
    for (const scope of scopes) {
      const base = scope.split('*')[0]?.replace(/\/$/, '') ?? '';
      const target = join(ROOT, base);
      let ok = false;
      try {
        ok = statSync(target).isDirectory() ? walk(target).length > 0 : true;
      } catch {
        ok = false;
      }
      if (!ok)
        findings.push({
          file: `.claude/rules/${name}`,
          line: 0,
          rule: 'rules-scope',
          message: `scope "${scope}" matches no file; fix or delete the rule`,
        });
    }
  }
}

if (findings.length) {
  for (const f of findings)
    console.log(
      `${f.file}${f.line ? `:${f.line}` : ''}  ${f.message}  [.claude/rules/${f.rule}.md]`,
    );
  console.log(`\nlint-seams: ${findings.length} finding(s)`);
  process.exit(1);
}
console.log('lint-seams: clean');
