# Search by meaning at scale — 2026-09-23

Roadmap "Server — next", items 5 and C5. Same 32-core machine; the
image-graph vault's 20,001 PNGs (2048×2048) on a board of their own.

## Embedding throughput (item 5)

The embed job received a page group of up to 16 images and ran the model
once per image. It now decodes the group concurrently and makes one model
call for all of it (`meaning/clip.ts#embedImages`).

| images per model call | ms per image (model only) |
| ---: | ---: |
| 1 | 29.3 |
| 8 | 9.9 |
| 16 | 10.6 |
| 32 | 6.6 |

End to end, every image of the 20,001-image board embedded from scratch:

| worker processes | time | ms per image | peak worker RSS |
| ---: | ---: | ---: | ---: |
| 1 | 189 s | 9.4 | 1,103 MB |
| 2 | 309 s | 15.4 | 1,193 MB |

The target was 20,000 photos searchable in under 10 minutes. A million is
now ~2.6 h on one worker, from ~21 h. A second worker process made it
slower: ONNX Runtime already spreads one model call over every core, so
two processes only contend. For embeddings, one worker with batching is
the right shape; the worker count stays one by default.

## Exact search (C5)

A query ranks every vector of the board. The HNSW index added in 0020
found 0–13% of the true top 20 among a million random 512-dimension
vectors (ef_search 40 → 1000); random vectors are HNSW's worst case, but
the exact scan made the question moot:

| board | exact scan, 150 results |
| --- | ---: |
| 1,000,000 vectors | 145–162 ms (parallel) |
| 150 vectors beside them | under 1 ms (board index) |

Search is exact (`ORDER BY distance + 0` keeps the planner off any vector
index) and 0024 drops the index. The owner's screenshot queries returned
identical results before and after.

## Near-duplicates (item 4)

`GET /boards/:id/duplicates?image=` answers with the images that are
nearly this one (`meaning/duplicates.ts`). It needs two tests, because
CLIP alone put them in the wrong order. On the owner's 141 screenshots,
two states of one app screen scored 0.9857, and a true re-capture scored
0.9763. So CLIP only picks candidates at 0.975 or more. The pixels then
decide: what share of the picture changed by more than 24 grey levels
between the two 128-px ladder cells. The share leaves out the letterbox
the two cells have in common. A wide screenshot fills only 40% of its
cell, so counting the letterbox would make every share smaller.

Every labelled pair from 0.95 up, changed share on the ladder cells:

| CLIP | label | changed |
| --- | --- | ---: |
| 0.9513–0.9695 (17 pairs) | different | 0.31–3.67% |
| 0.9737, 0.9742, 0.9748 | different | 1.78, 0.94, 0.58% |
| 0.9763 | re-capture | 0.02% |
| 0.9781 | re-capture | 0.00% |
| 0.9847 | re-capture | 0.32% |
| 0.9857 | same screen, other text | 0.72% |
| 0.9892 | re-capture | 0.04% |
| 0.9926 | re-capture | 0.01% |
| 0.9940 (burst) | re-capture | 0.00% |

The rule is a gate of 0.975 and a changed share of 0.5% or less. It
separates every labelled pair. Neither test is enough alone: below the
gate, one different pair changed only 0.31%. Over the whole board the
rule found 56 pairs among 32 images: every labelled re-capture, every
byte-identical copy, and none of the labelled non-duplicates. It took
0.8 ms per image, because the ladder already holds each cell. The
thresholds come from screenshots only; photos have not been measured.
