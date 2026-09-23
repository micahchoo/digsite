-- Phase 6 (docs/phases/6-product.md "Typed properties complete" /
-- docs/ux/design.md's find-and-filter spec): bookkeeping for
-- boards/property-index.ts#ensurePropertyIndex — an expression index on
-- `images ((properties->>key))` is created the first time a sort or filter
-- on that key is built for ANY board, recorded here so it happens once per
-- process lifetime *and* survives a restart (an in-memory Set alone would
-- redo the `CREATE INDEX IF NOT EXISTS` check, harmlessly but not "once").
CREATE TABLE board_property_indexes (
  board_id      uuid NOT NULL REFERENCES boards(id),
  property_key  text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (board_id, property_key)
);
