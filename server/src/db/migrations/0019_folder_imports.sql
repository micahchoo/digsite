-- CONTEXT.md "Folder import": images read from a folder on the server,
-- under a root the operator allowed (env IMPORT_ROOTS). The file list is
-- captured when the import starts, and `next` is advanced after every
-- file, so a worker that dies mid-import resumes where it stopped and
-- repeats at most the one file it was on.
CREATE TABLE folder_imports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  board_id    uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  user_id     text NOT NULL,
  path        text NOT NULL,
  files       text[] NOT NULL,
  next        integer NOT NULL DEFAULT 0,
  imported    integer NOT NULL DEFAULT 0,
  skipped     integer NOT NULL DEFAULT 0,
  -- The first few skip reasons, as {file, reason}: enough to explain a
  -- skip without storing one row per file.
  skips       jsonb NOT NULL DEFAULT '[]',
  state       text NOT NULL DEFAULT 'running'
    CHECK (state IN ('running', 'done')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX ON folder_imports (board_id, created_at DESC);
