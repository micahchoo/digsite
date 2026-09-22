// docs/measurements/phase-5.md "After the leftovers", problem 1 (the
// leak), lead review round 2: a free-list-with-a-cap bounds how many
// canvases are HELD resident, not how many are ever CREATED. A cold pan
// where the browser fires many concurrent tile requests can have far more
// than the cap's worth of `loadPageCanvas`/`composeTile` calls in flight
// at once — each one finds the free list empty, calls `createCanvas`, and
// since @napi-rs/canvas never frees a canvas's native buffer (this rule's
// own isolated finding), every one of those beyond the cap is a permanent
// leak the instant the free list has no room to take it back. The actual
// invariant that bounds total canvases ever created is "resident budget +
// however many loads/composes are allowed in flight at once" — this
// bounds the SECOND term, so the free list (uncapped — see ladder.ts and
// tiles.ts) never has more returned to it than this semaphore let out.
export class Semaphore {
  private available: number;
  private readonly waiters: (() => void)[] = [];

  constructor(concurrency: number) {
    this.available = concurrency;
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available--;
      return () => this.release();
    }
    // A waiter is only ever woken by `release()` handing its permit
    // directly (below) — it never re-checks `available` itself, so a
    // separate `acquire()` call can't race it for the same freed permit
    // between the release incrementing a count and the waiter actually
    // resuming (a real gap: resolving a promise doesn't run its
    // continuation synchronously).
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    return () => this.release();
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      next(); // hand the permit straight to the oldest waiter
      return;
    }
    this.available++;
  }

  /** Runs `fn` once a permit is available, always releasing it afterward —
   * the shape every caller here actually wants, so acquire/release can't
   * be mismatched by a forgotten `finally`. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
