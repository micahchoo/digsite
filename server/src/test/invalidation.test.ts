import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// boards/invalidation.ts across a real process boundary: a child process
// publishes, this process must drop what it holds. Before this module a
// worker process repainting a page left the API drawing the old one.
import { join } from 'node:path';
import {
  type Invalidation,
  listenForInvalidation,
  publish,
} from '../boards/invalidation.ts';
import { getPage, residentPagesForTest } from '../boards/ladder.ts';
import { getComposedTile, setComposedTile } from '../boards/tiles-cache.ts';

const MODULE = join(import.meta.dir, '../boards/invalidation.ts');

/** Publishes from another process, as a separate worker would. */
async function publishFromChild(event: Invalidation): Promise<void> {
  const child = Bun.spawn(
    [
      'bun',
      '-e',
      `const m = await import(${JSON.stringify(MODULE)});
       await m.publish(${JSON.stringify(event)});
       process.exit(0);`,
    ],
    { env: process.env, stdout: 'inherit', stderr: 'inherit' },
  );
  expect(await child.exited).toBe(0);
}

async function until(check: () => boolean, ms = 3_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return check();
}

describe('invalidation across processes', () => {
  let stop: () => void;
  beforeAll(async () => {
    stop = listenForInvalidation();
    // LISTEN is registered asynchronously; give the connection time.
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
  afterAll(() => stop());

  test('a page repainted elsewhere leaves this process', async () => {
    const boardId = crypto.randomUUID();
    await getPage(boardId, 32, 0);
    expect(residentPagesForTest(boardId)).toBe(1);
    await publishFromChild({ kind: 'page', boardId, s: 32, page: 0 });
    expect(await until(() => residentPagesForTest(boardId) === 0)).toBe(true);
  });

  test('ranks changed elsewhere drop composed tiles here', async () => {
    const boardId = crypto.randomUUID();
    const url = `/boards/${boardId}/tiles/name.asc/0/0/0.png`;
    setComposedTile(url, boardId, Buffer.from('tile'));
    await publishFromChild({ kind: 'ranks', boardId });
    expect(await until(() => getComposedTile(url) === undefined)).toBe(true);
  });

  test('a process ignores what it published itself', async () => {
    const boardId = crypto.randomUUID();
    await getPage(boardId, 32, 0);
    await publish({ kind: 'page', boardId, s: 32, page: 0 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(residentPagesForTest(boardId)).toBe(1);
  });
});
