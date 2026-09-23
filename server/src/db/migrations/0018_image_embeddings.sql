-- CONTEXT.md "Embedding": what an image means to a CLIP model, for
-- similarity and text search (roadmap stage 4). One row per image and
-- model. `vector` is the model's output normalised to unit length and
-- quantised to int8 (component * 127, rounded): 512 bytes for CLIP
-- ViT-B/32, 512 MB for a million images. pgvector is not installed on this
-- deployment's Postgres, so similarity is computed by the server, streaming
-- a board's vectors by slot range (boards/meaning.ts).
--
-- ON DELETE CASCADE: an embedding is derived from its image and means
-- nothing without it; the board delete removes images and these follow.
CREATE TABLE image_embeddings (
  image_id uuid NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  model    text NOT NULL,
  board_id uuid NOT NULL,
  slot     integer NOT NULL,
  vector   bytea NOT NULL,
  PRIMARY KEY (image_id, model)
);
CREATE INDEX ON image_embeddings (board_id, model, slot);
