// Tests through the one interface, against a temp directory: the module's
// dependency is the filesystem, and a temp tree is its stand-in.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { lintSeams } from './lint.ts';

let root = '';
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  root = mkdtempSync(join(tmpdir(), 'seams-'));
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  return root;
}

const rule = `---
scope: [server/src/**]
checks:
  - forbid: '"member"'
    in: server/src/**
    except: [server/src/access/, server/src/auth.ts]
    message: reads member outside access/
  - forbid: 'update\\s+ranks'
    in: server/src/**
    flags: i
    message: patches ranks
  - require: 'export function isSyncable'
    in: web/src/sheet/sync.ts
    message: sync.ts must export isSyncable
---
# a rule
`;

describe('lintSeams', () => {
  test('forbid reports file and line, honours except, applies flags', () => {
    const findings = lintSeams(
      tree({
        '.claude/rules/r.md': rule,
        'server/src/groups/routes.ts': 'a\nSELECT * FROM "member"\n',
        'server/src/access/index.ts': 'SELECT * FROM "member"',
        'server/src/auth.ts': '"member"',
        'server/src/boards/ranks.ts': 'UPDATE ranks SET x = 1',
        'web/src/sheet/sync.ts': 'export function isSyncable() {}',
      }),
    );
    expect(findings).toEqual([
      {
        file: 'server/src/boards/ranks.ts',
        line: 1,
        rule: '.claude/rules/r.md',
        message: 'patches ranks',
      },
      {
        file: 'server/src/groups/routes.ts',
        line: 2,
        rule: '.claude/rules/r.md',
        message: 'reads member outside access/',
      },
    ]);
  });

  test('require reports a missing pattern and a missing file', () => {
    const missingPattern = lintSeams(
      tree({
        '.claude/rules/r.md': rule,
        'server/src/a.ts': '',
        'web/src/sheet/sync.ts': 'nope',
      }),
    );
    expect(missingPattern.map((f) => f.message)).toEqual([
      'sync.ts must export isSyncable',
    ]);
    const missingFile = lintSeams(
      tree({ '.claude/rules/r.md': rule, 'server/src/a.ts': '' }),
    );
    expect(missingFile.map((f) => f.message)).toEqual([
      'sync.ts must export isSyncable (file missing)',
    ]);
  });

  test('a scope that matches no file is a finding on the rule itself', () => {
    const findings = lintSeams(
      tree({
        '.claude/rules/r.md': rule,
        'web/src/sheet/sync.ts': 'export function isSyncable() {}',
      }),
    );
    expect(findings).toEqual([
      {
        file: '.claude/rules/r.md',
        line: 0,
        rule: '.claude/rules/r.md',
        message:
          'scope "server/src/**" matches no file; fix or delete the rule',
      },
    ]);
  });

  test('a rule without checks only has its scope checked; node_modules is skipped', () => {
    const findings = lintSeams(
      tree({
        '.claude/rules/plain.md': '---\nscope: web/**\n---\n# plain\n',
        'web/a.ts': '',
        'node_modules/x/index.ts': '"member"',
      }),
    );
    expect(findings).toEqual([]);
  });
});
