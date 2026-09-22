#!/usr/bin/env bun
// CLI for scripts/seams/lint.ts: print findings, exit nonzero on any.
import { lintSeams } from './seams/lint.ts';

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const findings = lintSeams(root);
for (const f of findings)
  console.log(
    `${f.file}${f.line ? `:${f.line}` : ''}  ${f.message}  [${f.rule}]`,
  );
console.log(
  findings.length
    ? `\nlint-seams: ${findings.length} finding(s)`
    : 'lint-seams: clean',
);
process.exit(findings.length ? 1 : 0);
