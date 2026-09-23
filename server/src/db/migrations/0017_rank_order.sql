-- A sort's ranks as one value, not a million rows. `slot_order` is every
-- slot of the board in rank order, as 4-byte big-endian integers
-- (int4send), built in one statement by string_agg(... ORDER BY ...).
--
-- Why (roadmap stage 2, measured 2026-09-23 on a 1,000,000-image board):
-- rebuilding board_ranks row by row cost 1.5-6.0 s per sort — the insert
-- maintains a btree one row at a time — against a 2 s target, and a find
-- that joined it took 4.9 s. The same orders as bytea rebuilt in 0.3-1.1 s,
-- load in 28 ms and decode in 13 ms; the find, filtering images and mapping
-- slots to ranks in memory, took 63 ms. See boards/ranks.ts.
--
-- STORAGE EXTERNAL: TOAST without compression. The order is random-looking
-- integers; compressing it costs time on every write and read and saves
-- nothing.
ALTER TABLE board_rank_state ADD COLUMN slot_order bytea;
ALTER TABLE board_rank_state ALTER COLUMN slot_order SET STORAGE EXTERNAL;

-- Every existing order lives in board_ranks, which goes. Mark each sort
-- stale so its next request rebuilds it into slot_order.
UPDATE board_rank_state SET stale = true;
DROP TABLE board_ranks;
