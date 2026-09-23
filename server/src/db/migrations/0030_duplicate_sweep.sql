-- The board-wide duplicate sweep (meaning/sweep.ts): every pair of
-- near-duplicates on a board, replaced whole by each sweep, and when the
-- last sweep finished. A board with no row has never been swept.
CREATE TABLE duplicate_pairs (
  board_id uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  a        uuid NOT NULL,
  b        uuid NOT NULL,
  score    real NOT NULL,
  PRIMARY KEY (board_id, a, b)
);
CREATE TABLE duplicate_sweeps (
  board_id  uuid PRIMARY KEY REFERENCES boards(id) ON DELETE CASCADE,
  swept_at  timestamptz NOT NULL,
  pairs     integer NOT NULL
);

-- One pending sweep per board (worker/schedule.ts).
CREATE UNIQUE INDEX jobs_duplicate_sweep_pending_board
  ON jobs ((payload->>'boardId'))
  WHERE kind = 'duplicate-sweep' AND state = 'pending';
