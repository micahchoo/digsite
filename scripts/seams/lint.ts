// The seam linter. One entry point: `lintSeams(root)` returns every place
// the tree crosses a seam declared in `<root>/.claude/rules/*.md`.
//
// The interface — everything a rule author must know:
//
// A rule's frontmatter may carry `checks:`, a list of
//   - { forbid: <regex>, in: <selectors>, except?: <selectors>, message }
//       tested against every LINE of every selected file
//   - { require: <regex>, in: <one file path>, message }
//       tested against the WHOLE file; a missing file is a finding too
// plus optional `flags` (JavaScript regex flags, e.g. 'i').
// A selector is a path prefix ('dir/' or 'dir/**') or an exact file path,
// relative to the root with forward slashes. Regexes are JavaScript
// syntax. In YAML, write a regex in SINGLE quotes: double quotes treat
// backslashes as YAML escapes and '\s' is an error there.
// A rule's `scope` selectors must each match at least one file, or the rule
// itself is a finding (CLAUDE.md: prune dead scopes).
// Files considered: .ts .tsx .sql .md, skipping node_modules, dist, data,
// .git. Findings come back sorted by file then line.
//
// The filesystem is the module's only dependency and is local-substitutable:
// tests run it against a temp directory (lint.test.ts). There is no file
// port at the interface on purpose.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export type Finding = {
  file: string;
  line: number; // 0 for a whole-file or whole-rule finding
  rule: string; // repo-relative path of the rule
  message: string;
};

type Check =
  | {
      forbid: string;
      in: string | string[];
      except?: string | string[];
      flags?: string;
      message: string;
    }
  | { require: string; in: string; flags?: string; message: string };

type Rule = { path: string; scope: string[]; checks: Check[] };

const SKIP = new Set(['node_modules', 'dist', 'data', '.git']);
const LINTABLE = /\.(ts|tsx|sql|md)$/;

export function lintSeams(root: string): Finding[] {
  const paths = walk(root, root);
  const rules = paths
    .filter((p) => p.startsWith('.claude/rules/') && p.endsWith('.md'))
    .map((p) => parseRule(p, readFileSync(join(root, p), 'utf8')))
    .filter((r): r is Rule => r !== null);

  const findings: Finding[] = [];
  const read = (p: string) => readFileSync(join(root, p), 'utf8');

  for (const rule of rules) {
    for (const scope of rule.scope) {
      if (!paths.some((p) => selects(scope, p)))
        findings.push({
          file: rule.path,
          line: 0,
          rule: rule.path,
          message: `scope "${scope}" matches no file; fix or delete the rule`,
        });
    }
    for (const check of rule.checks) {
      if ('require' in check) {
        const present = paths.includes(check.in);
        const re = new RegExp(check.require, check.flags);
        if (!present || !re.test(read(check.in)))
          findings.push({
            file: check.in,
            line: 0,
            rule: rule.path,
            message: present
              ? check.message
              : `${check.message} (file missing)`,
          });
        continue;
      }
      const re = new RegExp(check.forbid, check.flags);
      const chosen = paths.filter(
        (p) =>
          list(check.in).some((s) => selects(s, p)) &&
          !list(check.except).some((s) => selects(s, p)),
      );
      for (const path of chosen) {
        read(path)
          .split('\n')
          .forEach((text, i) => {
            if (re.test(text))
              findings.push({
                file: path,
                line: i + 1,
                rule: rule.path,
                message: check.message,
              });
          });
      }
    }
  }
  return findings.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line,
  );
}

function walk(root: string, dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(root, full, out);
    else if (LINTABLE.test(name)) out.push(relative(root, full));
  }
  return out;
}

function parseRule(path: string, text: string): Rule | null {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m?.[1]) return null;
  const fm = Bun.YAML.parse(m[1]) as {
    scope?: string | string[];
    checks?: Check[];
  };
  return { path, scope: list(fm.scope), checks: fm.checks ?? [] };
}

function list(v: string | string[] | undefined): string[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

function selects(selector: string, path: string): boolean {
  const s = selector.replace(/\/?\*\*$/, '/');
  return s.endsWith('/') ? path.startsWith(s) : path === s;
}
