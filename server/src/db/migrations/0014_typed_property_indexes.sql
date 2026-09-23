-- Phase 6 typed properties: index bookkeeping distinguishes typed sort and
-- filter expressions. Old text-only indexes are harmless but their rows
-- must not suppress creation of the new expression/GIN indexes.
ALTER TABLE board_property_indexes
  ADD COLUMN property_type text;

DELETE FROM board_property_indexes;

ALTER TABLE board_property_indexes
  DROP CONSTRAINT board_property_indexes_pkey,
  ALTER COLUMN property_type SET NOT NULL,
  ADD CONSTRAINT board_property_indexes_type_check
    CHECK (property_type IN ('text', 'number', 'boolean', 'date', 'list')),
  ADD PRIMARY KEY (board_id, property_key, property_type);
