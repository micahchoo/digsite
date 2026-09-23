-- CONTEXT.md "Making sense". An edge says how sure its sheet is, and why.
-- Both are optional in a saved scene; the projection writes NULL and ''.
ALTER TABLE edges
  ADD COLUMN confidence text
    CHECK (confidence IN ('confirmed', 'likely', 'unverified')),
  ADD COLUMN note text NOT NULL DEFAULT '';

-- A board-level alias: `term` means `canonical`. Read-time only; no sheet's
-- scene is ever rewritten by one. Flat by construction (vocabulary.ts keeps
-- a canonical from being an alias itself). Deleted with its board in
-- boards/routes.ts's delete transaction, like every other board row.
CREATE TABLE term_aliases (
  board_id   uuid NOT NULL REFERENCES boards(id),
  kind       text NOT NULL CHECK (kind IN ('label', 'relation')),
  term       text NOT NULL,
  canonical  text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (board_id, kind, term),
  CHECK (term <> canonical)
);

-- Find by label or relation filters claim rows by term.
CREATE INDEX ON regions (label);
CREATE INDEX ON edges (relation);
