-- Phase 5 section 4 (docs/phases/5-hardening.md "Operability"): a failed
-- job is kept with its reason. Before this, only images.error carried a
-- reason, and only for the `ladder` kind (worker/jobs.ts#onJobFailedFinal)
-- — GET /boards/:id/jobs?state=failed (boards/routes.ts, under
-- boardForManagingAllowlist) needs one for every kind, set on every
-- attempt (worker/index.ts's backoff), not only the final one.
ALTER TABLE jobs ADD COLUMN last_error text;

-- GET /boards/:id/jobs filters by payload->>'boardId' and state; every
-- enqueue* function in worker/jobs.ts puts boardId in the payload (ladder,
-- rank-rebuild, materialise all do), so one index serves all three kinds.
CREATE INDEX ON jobs ((payload->>'boardId'), state);
