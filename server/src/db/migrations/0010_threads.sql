-- Phase 6 (docs/phases/6-product.md "Sheets are threads"): last-seen per
-- user per sheet, server-side so unread survives devices, and an archive
-- flag — archived sheets are hidden from GET /boards/:id/sheets by default
-- but never deleted (CONTEXT.md never describes a hard delete of a sheet
-- short of DELETE /sheets/:id itself).
CREATE TABLE sheet_reads (
  user_id  text NOT NULL,       -- user.id
  sheet_id uuid NOT NULL REFERENCES sheets(id),
  seen_at  timestamptz NOT NULL,
  PRIMARY KEY (user_id, sheet_id)
);

ALTER TABLE sheets ADD COLUMN archived boolean NOT NULL DEFAULT false;
