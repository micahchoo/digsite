-- A claimed job holds a lease, renewed while it runs. Before this, `claim`
-- set state = 'running' and nothing ever put it back: a worker killed
-- mid-job (the 16 GB OOM, docs/measurements/bulk-import-20000.md) left its
-- images pending forever. worker/index.ts#claim now also takes a running
-- job whose lease has expired, as its next attempt.
ALTER TABLE jobs ADD COLUMN lease_until timestamptz;

-- Jobs a dead worker already stranded: expired now, so the next claim
-- takes them.
UPDATE jobs SET lease_until = now() WHERE state = 'running';

CREATE INDEX ON jobs (lease_until) WHERE state = 'running';
