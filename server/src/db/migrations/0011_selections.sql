-- Phase 6 (docs/phases/6-product.md "Selection"): a selection is a set of
-- image ids owned by the viewer, per board — never ranks (a rank changes
-- with the sort; see ../../../.claude/rules/ladder-slot-vs-rank.md). Order
-- is preserved (the tray's order), deduped and capped at 5,000 by the route,
-- not by a constraint here.
CREATE TABLE board_selections (
  user_id    text NOT NULL,        -- user.id
  board_id   uuid NOT NULL REFERENCES boards(id),
  image_ids  uuid[] NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, board_id)
);
