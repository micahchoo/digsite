-- Embeddings move into pgvector (roadmap stage 4). 0018 stored them as int8
-- bytea and scored every one of a board's vectors in the server: 2.15 s for
-- a million. pgvector's HNSW index answers a nearest-neighbour query without
-- reading them all. The Postgres image now carries the extension
-- (db/Dockerfile, the same Alpine base as before).
--
-- halfvec: 2 bytes a dimension, 1 KB per CLIP vector, and what HNSW indexes
-- at this size most cheaply. The table is rebuilt, not converted: 0018 was
-- a day old, off by default, and no deployment holds embeddings.
CREATE EXTENSION IF NOT EXISTS vector;

DROP TABLE image_embeddings;

CREATE TABLE image_embeddings (
  image_id  uuid NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  model     text NOT NULL,
  board_id  uuid NOT NULL,
  slot      integer NOT NULL,
  embedding halfvec(512) NOT NULL,
  PRIMARY KEY (image_id, model)
);
CREATE INDEX ON image_embeddings (board_id, model, slot);
-- One index across boards; a query filters by board with pgvector's
-- iterative scan (meaning/search.ts), so a small board among large ones
-- still gets its full count of results.
CREATE INDEX ON image_embeddings USING hnsw (embedding halfvec_cosine_ops);
