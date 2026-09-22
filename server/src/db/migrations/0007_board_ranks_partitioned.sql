-- docs/phases/5-hardening.md section 5: "board_ranks partitioned by
-- board_id (hash, 16 partitions, or list per board — measure both on the
-- 1M board and keep the faster)". Measured on "Synthetic 1M"
-- (25f375ea-4e5e-40c4-b21b-9ad863dbbab1, docs/measurements/phase-1-map.md),
-- results in docs/measurements/phase-5.md: hash(16) and list-per-board
-- landed within ~10% of each other (list slightly faster: 2.59s vs 2.77s
-- insert, on this board's accumulated 5,000,000-row multi-sort history) —
-- neither reaches the <=2s target, because BOTH strategies key on board_id
-- alone, and this board's own partition still carries every sort it has
-- ever had rebuilt (board_ranks_pkey orders (board_id, sort_id, rank), so
-- one board's rows across five sort_ids share one partition's btree either
-- way). Kept: hash(16). It needs no per-board DDL wired into board
-- creation/deletion (list-per-board would — out of this migration's reach,
-- since boards/routes.ts's board-create route is owned by another agent
-- this phase; flagged in phase-5.md for the lead) and, on a fleet of many
-- boards of ORDINARY size rather than this one dev board's unusual history,
-- a board's rows land in a partition roughly 1/16th the size of today's
-- single global table shared across every board this database has ever
-- ranked.
--
-- Swap, not ALTER: Postgres has no ALTER TABLE ... PARTITION BY. Create the
-- partitioned replacement, copy every existing row across, then hand
-- board_ranks's name from the old table to the new one — all inside this
-- one transaction (migrate.ts wraps every migration file in BEGIN/COMMIT),
-- so no concurrent query ever sees the table missing. Every column and the
-- primary key are unchanged, so ranks.ts's DML is byte-for-byte the same
-- after this runs: Postgres routes an INSERT/DELETE/SELECT carrying a
-- board_id predicate to (or from) the right partition on its own, and
-- partition pruning keeps every existing query plan a single-partition
-- operation — nothing above the schema needed to change.
ALTER TABLE board_ranks RENAME TO board_ranks_pre_0007;

CREATE TABLE board_ranks (
  board_id uuid NOT NULL,
  sort_id  text NOT NULL,
  rank     integer NOT NULL,
  slot     integer NOT NULL,
  PRIMARY KEY (board_id, sort_id, rank)
) PARTITION BY HASH (board_id);

DO $$
BEGIN
  FOR i IN 0..15 LOOP
    EXECUTE format(
      'CREATE TABLE board_ranks_p%1$s PARTITION OF board_ranks FOR VALUES WITH (MODULUS 16, REMAINDER %1$s)',
      i
    );
  END LOOP;
END $$;

INSERT INTO board_ranks SELECT * FROM board_ranks_pre_0007;

DROP TABLE board_ranks_pre_0007;
