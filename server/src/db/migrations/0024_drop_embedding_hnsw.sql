-- Search by meaning is exact (meaning/search.ts, roadmap C5). The HNSW
-- index from 0020 found 0-13% of the true top 20 among a million random
-- vectors; an exact scan, scoped to one board by the (board_id, model,
-- slot) index, found all of them in 145-162 ms. An index no query uses
-- costs 1.3 GB per million images and a write on every embedding.
DROP INDEX IF EXISTS image_embeddings_embedding_idx;
