import { expect, test } from 'bun:test';
import { workerLoop } from '../worker/loop.ts';

test('busy batches continue without the idle delay, with no overlapping polls', async () => {
  let active = 0;
  let peak = 0;
  let calls = 0;
  let release!: () => void;
  const first = new Promise<void>((resolve) => {
    release = resolve;
  });
  let finished!: () => void;
  const done = new Promise<void>((resolve) => {
    finished = resolve;
  });
  const stop = workerLoop(
    async () => {
      active++;
      peak = Math.max(peak, active);
      calls++;
      if (calls === 1) await first;
      active--;
      if (calls === 3) finished();
      return calls < 3 ? 4 : 0;
    },
    (error) => {
      throw error;
    },
    1000,
  );
  try {
    await Bun.sleep(50);
    expect(calls).toBe(1);
    release();
    await Promise.race([
      done,
      Bun.sleep(500).then(() => {
        throw new Error('busy worker slept');
      }),
    ]);
    expect(calls).toBe(3);
    expect(peak).toBe(1);
    await Bun.sleep(30);
    expect(calls).toBe(3);
  } finally {
    stop();
    release();
  }
});

test('stopping during a poll prevents scheduling further work', async () => {
  let release!: () => void;
  let calls = 0;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stop = workerLoop(
    async () => {
      calls++;
      await pending;
      return 4;
    },
    () => {},
  );
  await Bun.sleep(20);
  stop();
  release();
  await Bun.sleep(20);
  expect(calls).toBe(1);
});
