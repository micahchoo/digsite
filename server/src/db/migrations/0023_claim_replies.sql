-- CONTEXT.md "Reply": what people say about one claim. Append-only: a reply
-- is never edited, and deleting one only marks it, so two people answering
-- at once can never overwrite each other (a reply inside the claim's
-- customData could: the scene merges whole elements by version).
--
-- `element_id` is the claim's element id on its sheet; a claim deleted from
-- the scene leaves its replies unread, never wrong. Deleted with its sheet
-- (and so with its board) by the foreign key.
CREATE TABLE claim_replies (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  board_id   uuid NOT NULL REFERENCES boards(id),
  sheet_id   uuid NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  element_id text NOT NULL,
  user_id    text NOT NULL,
  body       text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX ON claim_replies (sheet_id, element_id, created_at);
