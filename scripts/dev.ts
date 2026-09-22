#!/usr/bin/env bun
// Spawns the server and web dev servers together and exits nonzero if either
// dies. `bun run --filter '*' dev` runs workspaces sequentially, not
// concurrently, so this is the one that actually gives a "both up" dev loop.
const specs = [
  ['@digsite/server', 'server'],
  ['@digsite/web', 'web'],
] as const;

const procs = specs.map(
  ([pkg, label]) =>
    [
      label,
      Bun.spawn(['bun', 'run', '--filter', pkg, 'dev'], {
        stdio: ['inherit', 'inherit', 'inherit'],
      }),
    ] as const,
);

let exiting = false;
function killAll() {
  if (exiting) return;
  exiting = true;
  for (const [, proc] of procs) proc.kill();
}

process.on('SIGINT', killAll);
process.on('SIGTERM', killAll);

const results = await Promise.all(
  procs.map(async ([label, proc]) => {
    const code = await proc.exited;
    return { label, code };
  }),
);

killAll();
for (const { label, code } of results) {
  if (code !== 0) console.error(`[dev] ${label} exited with code ${code}`);
}
process.exit(results.some((r) => r.code !== 0) ? 1 : 0);
