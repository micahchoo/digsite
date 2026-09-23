import { describe, expect, test } from 'bun:test';
// storage/lock.ts across a real process boundary: a worker process painting
// a page must exclude a second worker process painting the same page.
import { join } from 'node:path';
import { withLock } from '../storage/lock.ts';

const MODULE = join(import.meta.dir, '../storage/lock.ts');

describe('withLock across processes', () => {
  test('a key held by another process is waited for', async () => {
    const key = `lock-test-${crypto.randomUUID()}`;
    const child = Bun.spawn(
      [
        'bun',
        '-e',
        `const { withLock } = await import(${JSON.stringify(MODULE)});
         await withLock(${JSON.stringify(key)}, async () => {
           console.log('held');
           await Bun.sleep(800);
         });
         process.exit(0);`,
      ],
      { env: process.env, stdout: 'pipe', stderr: 'inherit' },
    );
    // Wait until the child reports it holds the lock.
    const reader = child.stdout.getReader();
    let seen = '';
    while (!seen.includes('held')) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += new TextDecoder().decode(value);
    }
    expect(seen).toContain('held');

    const start = Date.now();
    await withLock(key, async () => {});
    expect(Date.now() - start).toBeGreaterThan(500);
    expect(await child.exited).toBe(0);
  }, 15_000);

  test('different keys do not wait for each other', async () => {
    let inner = 0;
    await withLock('lock-a', async () => {
      await withLock('lock-b', async () => {
        inner++;
      });
    });
    expect(inner).toBe(1);
  });
});
