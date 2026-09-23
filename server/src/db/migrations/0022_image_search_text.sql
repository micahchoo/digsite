-- Narrow find at a million images (roadmap item 2). Find matched a term
-- against the name OR any property value, and the property half expanded
-- every image's jsonb with jsonb_each_text: no index could serve it, and a
-- query matching little still cost ~1.2 s at a million images.
--
-- `search_text` holds the name and every property value, joined by \x1f
-- (unit separator), which no query term can contain — so a term matches
-- inside the name or inside one value, never across two, exactly as
-- before. A trigram index makes `ILIKE '%term%'` an index scan.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- IMMUTABLE is true: the text depends only on the arguments, and
-- jsonb_each_text and string_agg are themselves immutable. Value order is
-- jsonb's own key order, which is deterministic.
CREATE FUNCTION image_search_text(name text, properties jsonb)
  RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT name || E'\x1f' || coalesce(
    (SELECT string_agg(value, E'\x1f') FROM jsonb_each_text(properties)),
    '')
$$;

ALTER TABLE images
  ADD COLUMN search_text text
  GENERATED ALWAYS AS (image_search_text(name, properties)) STORED;

CREATE INDEX images_search_text_trgm ON images USING gin (search_text gin_trgm_ops);

-- The name-only trigram index find.ts used to create at runtime serves no
-- query now; dropping it saves its upkeep on every upload.
DROP INDEX IF EXISTS idx_images_name_trgm;
