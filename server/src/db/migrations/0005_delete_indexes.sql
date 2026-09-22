-- Phase 3 (docs/phases/3-groups.md section 4): board/sheet deletion filters
-- regions/edges by sheet_id (delete the sheet's own rows, and the sheet
-- footprint's cross-sheet count), and neither had an index for that — only
-- image_id/src_image_id/dst_image_id did (0002_domain.sql). Postgres does
-- not index a foreign-key column on its own.
CREATE INDEX ON regions (sheet_id);
CREATE INDEX ON edges (sheet_id);

-- DELETE /images/:id (boards/routes.ts) checks whether another image on the
-- same board still needs the same original file (uploadOne dedupes by
-- sha256 within a board) before unlinking it. board_id already leads two
-- indexes (uploaded_at, name) but neither carries sha256.
CREATE INDEX ON images (board_id, sha256);
