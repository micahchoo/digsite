-- Folder re-sync: every file a folder import put on a board (or found its
-- bytes already there), by absolute path, with the size and modification
-- time it had. A later import of the same folder passes over a file whose
-- record still matches without reading it, so importing a 3 GB folder
-- again for its new photos costs a stat per file, not a read and a hash.
CREATE TABLE folder_files (
  board_id uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  path     text NOT NULL,
  size     bigint NOT NULL,
  mtime_ms bigint NOT NULL,
  PRIMARY KEY (board_id, path)
);
ALTER TABLE folder_imports ADD COLUMN unchanged integer NOT NULL DEFAULT 0;
