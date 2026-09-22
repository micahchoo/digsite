import { describe, expect, test } from 'bun:test';
import { Semaphore } from '../util/semaphore.ts';

describe('Semaphore', () => {
  test('never lets more than `concurrency` callers run at once', async () => {
    const sem = new Semaphore(3);
    let inFlight = 0;
    let maxInFlight = 0;
    const tasks = Array.from({ length: 20 }, () =>
      sem.run(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
      }),
    );
    await Promise.all(tasks);
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(inFlight).toBe(0);
  });

  test('releases correctly under an adversarial interleaving (release racing a fresh acquire)', async () => {
    const sem = new Semaphore(1);
    const order: string[] = [];

    const release1 = await sem.acquire();
    // A second and third acquire both queue as waiters.
    const p2 = sem.acquire().then((rel) => {
      order.push('2');
      return rel;
    });
    const p3 = sem.acquire().then((rel) => {
      order.push('3');
      return rel;
    });

    release1();
    const rel2 = await p2;
    // While holder 2 is still active, fire a FOURTH acquire — it must not
    // be able to grab the permit ahead of the already-queued waiter 3
    // (this is exactly the race the direct-handoff release() avoids).
    const p4 = sem.acquire().then((rel) => {
      order.push('4');
      return rel;
    });
    rel2();
    const rel3 = await p3;
    order.push('done-with-3');
    rel3();
    const rel4 = await p4;
    rel4();

    expect(order.indexOf('3')).toBeLessThan(order.indexOf('4'));
  });
});
