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

## A map arranged by meaning (item 6)

The `meaning` sort reads `images.meaning_pos`. The worker's `arrange`
job writes that column from a bisecting 2-means tree over the board's
embeddings (`meaning/arrange.ts`). At each split, the half nearer the
last placed picture goes first. Inside a leaf of 16, pictures follow a
nearest-neighbour chain. Images not yet placed sort last.

Quality: how often an image's single best match (exact, over the whole
board) sits within 32 ranks, two map rows, of it. Up to 500 sampled
images.

| board | meaning | upload order | random |
| --- | ---: | ---: | ---: |
| owner's screenshots (142) | 88.7% | 66.2% | 38.0% |
| bulk-import photos (20,001) | 14.4% | 0.4% | 0.6% |

Mean similarity between map neighbours (right and below) moved the same
way: 0.758 against 0.725 and 0.681 on the screenshots, and 0.952 against
0.923 and 0.923 on the photos.

Cost at 1,000,000 random 512-d vectors, the worst case for structure:

| step | time |
| --- | ---: |
| load (float16 binary, 20,000 a page) | 4.6 s |
| arrange | 72–86 s |
| write positions, all new / none changed | ~50 s / ~0 s |
| whole job, first / again | 130 s / 81 s |
| rank rebuild `meaning.asc` | 0.26–0.40 s |

Peak RSS was 2.5 GB, the vectors' own 2 GB plus working space, under
the worker's 3,072 MB retire line. It took three fixes to get there,
each measured, all from memory outside the JS heap:

- Per-split typed arrays (centroids, scores, rotation copies), about
  60,000 splits' worth, grew RSS from 2.5 to 6 GB while the heap stayed
  flat. One workspace for the whole run now holds it flat.
- Each page's hex bytea text and Buffers peaked the load at 6.4 GB,
  with no collection or a minor one per page alike. A full `Bun.gc(true)`
  per page: 2.4 GB, and no slower.
- Clearing old positions with `id <> ALL($1M ids)` scanned the whole
  array for every positioned row. It is now `NOT EXISTS` on the
  embeddings index.

Positions are written in batches of 20,000, each its own transaction.
One transaction over a million rows held every image's row lock for
55 s.

`GET /boards/:id` gives `meaningUnplaced`, embedded minus placed. That
is two index-only counts, about 50 ms at a million. The arrangement is
deterministic, so at 0 the order does not move until a new picture is
embedded.

### Bounded by a budget, not by the board (2026-09-23, later)

`meaning/embeddings.ts` packs a board's vectors as float32 while they fit
`ARRANGE_BUDGET_MB` (1.5 GB, 750,000 images) and as int8 (x127) beyond
it. Measured before choosing:

| | float32 | int8 | Float16Array |
| --- | ---: | ---: | ---: |
| arrange 100,000 random vectors | 5.0 s | — | 71.7 s |
| 20,001 photos: best match within two rows | 14.8% | 12.8% | — |
| 20,001 photos: neighbour similarity | 0.9514 | 0.9513 | — |
| 20,001 photos: arrange | 0.68 s | 1.53 s | — |

At a million images the default budget takes int8: peak RSS 0.98 GB
(was 2.5 GB), 108 s to re-arrange (was 81 s), 219 s the first time,
when every position changed.

### New pictures placed one at a time

A burst of new pictures no longer re-arranges the board. Each one goes
right after its nearest placed neighbour, midway to the next position
(`meaning_pos` is a double now), and joins that neighbour's group. A
full arrangement runs only when more than 200 pictures, or more than 10%
of those placed, are new.

| at 1,000,000 images | time |
| --- | ---: |
| full arrangement | 108–219 s |
| one new picture, first version (exact search joined to images) | 601 ms |
| one new picture, now (search the vectors alone, 8 deep) | 141 ms |
| 50 new pictures | 7.0 s |

The `meaning` sort now has sections: the arrangement's groups, each
about a sixteenth of the board. Each group takes the name of the board
label term nearest its centroid, with a number when two groups share
one, and "Group n" on a board without labels.
