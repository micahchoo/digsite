-- A phone or camera file becomes a JPEG original at intake; the file it
-- came from is kept as the image's source (boards/intake.ts), stored at
-- boards/<id>/sources/<source_sha256> and served by GET /images/:id/source.
-- `bytes` is the original's size, recorded from now on for storage quotas.
ALTER TABLE images
  ADD COLUMN bytes bigint,
  ADD COLUMN source_sha256 text,
  ADD COLUMN source_format text,
  ADD COLUMN source_bytes bigint;
