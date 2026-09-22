-- docs/measurements/phase-5.md "After the leftovers", problem 3 (rank
-- rebuild <= 2s at 1M). Root cause, confirmed twice now (phase-1-map.md's
-- "Fix 1", phase-5.md's partitioning section): board_ranks_pkey's insert
-- cost is proportional to the SIZE OF THE PARTITION the rebuild's rows land
-- in, and hash/list partitioning by board_id alone does nothing about a
-- single board's own accumulated sort_id history — a board rebuilt under
-- five different sorts over its life carries all five sorts' rows in one
-- partition regardless of partitioning strategy, because board_ranks_pkey
-- is (board_id, sort_id, rank). A sort nobody has asked for in a long time
-- is dead weight in that same index every OTHER sort on that board pays to
-- maintain. `last_requested_at` is what a sweep (ranks.ts#sweepStaleRanks)
-- measures staleness by — bumped on every ensureRank call that finds the
-- rank table already fresh (throttled, not every single tile request; see
-- ranks.ts), and on every rebuild. Backfilled from built_at rather than
-- defaulting to "just requested now" for existing rows, so a sweep run
-- right after this migration reflects genuine last-use, not a false
-- freshness this migration would otherwise hand every historical sort.
ALTER TABLE board_rank_state
  ADD COLUMN last_requested_at timestamptz NOT NULL DEFAULT now();

UPDATE board_rank_state SET last_requested_at = built_at;
