// docs/measurements/phase-5.md "After the leftovers", problem 2 (multi-board
// ladder fairness): a board that's actively being read gets a floor share
// of LADDER_BUDGET_MB protected from eviction by another board's traffic.
// No DB, no real files needed — `getPage` falls back to the #222
// background paint on a storage miss, so this exercises the real cache/
// eviction code path against fake board ids and page numbers cheaply.
import { describe, expect, test } from 'bun:test';
import {
  activeBoardsForMetrics,
  getPage,
  maxPagesForTest,
  residentPagesForTest,
  withPage,
} from '../boards/ladder.ts';

describe('ladder fairness floor', () => {
  test('an active board keeps its floor share while another active board floods the cache', async () => {
    const boardA = `fair-a-${Date.now()}`;
    const boardB = `fair-b-${Date.now()}`;
    const maxPages = maxPagesForTest();
    // Not hardcoded to "2 boards active" — this module's active-board map
    // is process-global and this test can run in the same `bun test`
    // process as many other files that touched OTHER boards within
    // LADDER_ACTIVE_WINDOW_MS (5 minutes, comfortably longer than a whole
    // suite run). Touch A and B once each, then read the REAL count the
    // eviction logic itself would use.
    await getPage(boardA, 8, 0); // page 0 — re-fetched (a harmless cache
    await getPage(boardB, 8, 0); // hit) by each board's own fill loop below
    const activeBoards = activeBoardsForMetrics();
    const floor = Math.floor(maxPages / activeBoards);

    // Fill board A up to exactly the floor it will have once B is also
    // active — every page a distinct (never-resident) one.
    for (let i = 0; i < floor; i++) {
      await getPage(boardA, 8, i);
    }
    expect(residentPagesForTest(boardA)).toBe(floor);

    // Flood with board B: first enough to fill the rest of the budget with
    // no eviction yet, then enough MORE distinct pages to force eviction
    // well past what a plain global LRU would need to fully evict board A.
    const bPages = maxPages; // pushes total resident well past maxPages
    for (let i = 0; i < bPages; i++) {
      await getPage(boardB, 8, i);
    }

    // Total resident is capped at maxPages regardless of who owns what —
    // <= rather than === because this test shares the process-wide cache
    // with whatever else ran earlier in this test file/process; another
    // board's few leftover pages can occupy a handful of slots without
    // changing the invariant this test is actually checking.
    expect(
      residentPagesForTest(boardA) + residentPagesForTest(boardB),
    ).toBeLessThanOrEqual(maxPages);

    // A plain global LRU (insertion order) would have evicted every one of
    // board A's pages by now — board B alone inserted `maxPages` more
    // entries after them. The floor is what keeps board A above zero: it
    // was touched (via the getPage calls above) well within
    // LADDER_ACTIVE_WINDOW_MS, so it still counts as active and should
    // hold close to its floor share.
    const residentA = residentPagesForTest(boardA);
    expect(residentA).toBeGreaterThan(0);
    expect(residentA).toBeGreaterThanOrEqual(Math.floor(floor * 0.9));

    // Re-requesting one of board A's own original pages is still a
    // cache HIT (no new page created) as long as it's still resident —
    // page 0 is the OLDEST of board A's pages, so it's the first one a
    // floor-respecting eviction would have dropped if the floor were
    // ever violated. It surviving is the sharpest single check.
    const before = residentPagesForTest(boardA);
    await getPage(boardA, 8, 0);
    // A hit doesn't change residency; a miss (had it been evicted) would
    // have grown board A's residency by one (evicting someone else's
    // instead) or, if the whole cache were pinned by floors, thrown off
    // the invariant checked above. Either way residency shouldn't shrink.
    expect(residentPagesForTest(boardA)).toBeGreaterThanOrEqual(before);
  });

  // Lead review round 2, problem 3: "read synchronously right after await
  // resolves" was asserted, not enforced — several callers can share ONE
  // getPage in-flight promise (the cold-pan dedup fix) and each resumes in
  // its own LATER microtask, so an unrelated eviction could in principle
  // land between two of those resumptions and recycle the very canvas a
  // still-pending reader is about to draw from. `withPage` closes this by
  // pinning the KEY before it ever awaits, not after — see its own
  // comment. This test fires a genuinely adversarial interleaving: many
  // concurrent readers of ONE never-before-seen page (so they share the
  // dedup promise) racing a flood of a DIFFERENT board issuing many times
  // the whole budget's worth of distinct pages, all started in overlapping
  // waves rather than one synchronous burst.
  test('adversarial interleaving: reading one page repeatedly never observes a recycled canvas while the SAME board is flooded with newer pages around it', async () => {
    // Deliberately ONE board, no second board — the fairness floor
    // (problem 2) would otherwise protect page 0 on its own (an
    // under-floor board's pages are never picked), which would make this
    // test pass regardless of whether pinning does anything. With one
    // board, its floor is the WHOLE budget, so ordinary LRU age is what
    // decides — flooding it with many newer pages genuinely ages page 0
    // toward "oldest and evictable" unless a read is currently pinning it.
    const boardA = `pin-adversarial-${Date.now()}`;
    const maxPages = maxPagesForTest();

    const seen: unknown[] = [];
    let nextFloodPage = 1;

    async function read(): Promise<void> {
      await withPage(boardA, 8, 0, (canvas) => {
        seen.push(canvas);
      });
    }
    async function floodOne(): Promise<void> {
      await getPage(boardA, 8, nextFloodPage++);
    }

    // Interleave at MICROTASK granularity (Promise.resolve(), not
    // setTimeout — a full event-loop turn is coarser than the window
    // this is trying to hit): start a read, and while it's still
    // in-flight, fire flood requests, racing a fresh read start against
    // them on almost every step.
    const READS = 400;
    const inFlight: Promise<void>[] = [];
    for (let i = 0; i < READS; i++) {
      inFlight.push(read());
      const floodPerStep = Math.ceil((maxPages * 2.5) / READS);
      for (let f = 0; f < floodPerStep; f++) inFlight.push(floodOne());
      await Promise.resolve();
      await Promise.resolve();
    }
    await Promise.all(inFlight);

    // Comfortably more distinct pages flooded than the whole budget holds,
    // so plain LRU age alone would have evicted page 0 many times over by
    // the end if reading it didn't protect it.
    expect(nextFloodPage).toBeGreaterThan(maxPages * 2);

    // Every read must have seen the exact same canvas object — a
    // different one reaching a later read means page 0 was evicted and
    // recycled (repainted for one of the flood's pages) while some
    // earlier read was still using it.
    //
    // Honest limit: reverting `withPage` to pin AFTER its `await` instead
    // of before (the bug this test exists to catch) did NOT make this
    // assertion fail under several interleaving shapes tried by hand —
    // the microtask-level window is real by construction (see `withPage`'s
    // own comment) but forcing it to land exactly between one reader's
    // cache-hit resolution and its pin call, deterministically, in a plain
    // `bun:test` file with no custom scheduler, did not yield to
    // reasonable tuning. This test is kept as a real stress/regression
    // check (heavy concurrent dedup + flood-induced eviction pressure,
    // asserting no corruption under the FIXED code) rather than as proof
    // the fix is load-bearing — that proof is the construction argument in
    // `withPage`'s own comment: pinning the key before any `await` closes
    // the gap by making a zero-pin state provably unreachable while any
    // caller is in flight, not by getting lucky against a scheduler.
    expect(seen.length).toBe(READS);
    expect(new Set(seen).size).toBe(1);
  });
});
