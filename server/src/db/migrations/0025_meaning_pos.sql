-- Roadmap item 6: a board arranged by meaning. meaning_pos is an image's
-- place in its board's arrangement (meaning/arrangement.ts), read by the
-- `meaning` sort like any column key. NULL until the image is embedded
-- and the board arranged again; it then sorts last.
ALTER TABLE images ADD COLUMN meaning_pos integer;

-- GET /boards/:id counts a board's placed images on every load
-- (arrangement.ts#arrangementOf); this keeps that an index-only count.
CREATE INDEX images_board_placed ON images (board_id) WHERE meaning_pos IS NOT NULL;

-- One pending arrangement per board: meaning/arrangement.ts#
-- enqueueArrangeDebounced upserts through this, so a burst of embed jobs
-- ends in one arrangement.
CREATE UNIQUE INDEX jobs_arrange_pending_board
  ON jobs ((payload->>'boardId'))
  WHERE kind = 'arrange' AND state = 'pending';
