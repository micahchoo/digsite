-- CONTEXT.md "Kept report", "Published report". A kept report is a
-- report's data (shared/report/data.ts, digsite-report/1) frozen when it
-- was made, so what was cited can be drawn again and compared with the
-- board now. `data` is never updated after insert; only the link columns
-- change.
--
-- A sheet it came from may be deleted and the report stays: it is a record
-- of what the sheet said. It goes with its board (boards/removal.ts).
--
-- The link: `share_token` is set when someone publishes it and cleared
-- when anyone allowed revokes it. A token is 32 random bytes, base64url,
-- and is the whole secret; nothing else about the report is guessable.
CREATE TABLE reports (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  board_id     uuid NOT NULL REFERENCES boards(id),
  title        text NOT NULL,
  scope        jsonb NOT NULL,
  data         jsonb NOT NULL,
  made_by      text NOT NULL,
  made_at      timestamptz NOT NULL DEFAULT now(),
  share_token  text UNIQUE,
  published_by text,
  published_at timestamptz,
  expires_at   timestamptz
);

CREATE INDEX ON reports (board_id, made_at DESC);
