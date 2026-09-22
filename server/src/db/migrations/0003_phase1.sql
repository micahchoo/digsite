-- Phase 1 (docs/phases/1-map.md): uploads move to a worker, so an image can
-- be pending or failed before its ladder is painted; a `jobs` queue drives
-- the worker; materialised coarse tiles record when they were last built.
-- Existing rows default to 'ready' (docs/phases/1-map.md's "Environment").
ALTER TABLE images ADD COLUMN status text NOT NULL DEFAULT 'ready'
  CHECK (status IN ('ready', 'pending', 'failed'));
ALTER TABLE images ADD COLUMN error text;

CREATE TABLE jobs (
  id         serial PRIMARY KEY,
  kind       text NOT NULL,
  payload    jsonb NOT NULL DEFAULT '{}',
  state      text NOT NULL DEFAULT 'pending', -- pending | running | failed
  attempts   integer NOT NULL DEFAULT 0,
  run_after  timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON jobs (state, run_after);

-- One pending rank-rebuild job per board: worker/jobs.ts#enqueueRankRebuildDebounced
-- upserts through this index instead of piling up a second row when a batch
-- of uploads lands close together.
CREATE UNIQUE INDEX jobs_rank_rebuild_pending_board
  ON jobs ((payload->>'boardId'))
  WHERE kind = 'rank-rebuild' AND state = 'pending';

ALTER TABLE board_rank_state ADD COLUMN materialised_at timestamptz;
