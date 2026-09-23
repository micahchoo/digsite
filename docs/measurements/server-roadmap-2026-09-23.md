# Server roadmap, stages 1–6 — 2026-09-23

Each stage had a test that says it is done. This is what each test
measured, on the development machine (32 cores, 122 GB RAM, Postgres 16 in
the `digsite-db` container). The files are the image-graph vault's 20,001
PNGs (see `bulk-import-20000.md`); the million-image numbers come from a
board of generated rows.

## Stage 1 — memory is a contract

**Test:** a 20,000-image import, then an hour of panning, under a hard 4 GB
cgroup (`systemd-run --scope -p MemoryMax=4G -p MemorySwapMax=0 -p
OOMPolicy=continue`), with `LADDER_BUDGET_MB=1024`, `COARSE_BUDGET_MB=256`,
`MATERIALISE_BUDGET_MB=512`, `WORKER_RSS_LIMIT_MB=1536`.

**Passed, soak 4:**

| | import (268 s) | pan (60 min, 8 concurrent) |
| --- | ---: | ---: |
| requests | 20,001 files, 0 failed images | 694,255 tiles, 0 errors, 0 5xx |
| OOM kills | 0 | 0 |
| worker exits | 0 | 0 |
| API RSS, peak | 278 MB | 1,221 MB |
| worker RSS, peak | 1,396 MB | 1,367 MB |

API RSS through the pan, sampled every 10 minutes: 1,199, 1,216, 1,186,
1,194, 1,180 MB — flat. The cgroup's own figure sat at the 4 GB cap
throughout; that figure includes page cache, which the kernel reclaims
before it kills anything, and it killed nothing.

Four soaks were run. Each of the first three failed and named a defect:

| soak | what failed | fix |
| --- | --- | --- |
| 1 | the whole unit OOM-killed; 13 images stranded "Invalid SVG image" | `OOMPolicy=continue`; see soak 3 for the decode |
| 2 | 3 worker OOM kills (one worker reached 3.4 GB in 31 s) | full-size decodes bounded to `WORKER_CONCURRENCY` per process (`worker/decode.ts`); materialise one at a time |
| 3 | one image still "Invalid SVG image" | `@napi-rs/canvas` decodes nothing: its decoder rejects some valid PNGs, whoever wrote them |
| 4 | — | — |

In soak 2 the design held while the defect was live: every killed worker
was replaced within 500 ms, the API never restarted, leased jobs came back.

**The decoder defect.** `@napi-rs/canvas` wrote a ladder page it could not
read back; the file's chunks, CRCs and zlib stream are all valid, and libvips
reads it. Re-encoding the same pixels with the canvas library reproduces the
failure; with libvips it does not; and a PNG libvips made for another image
failed in the canvas decoder too. The pixels are
`server/src/test/fixtures/page-canvas-cannot-read.png`, and
`page-decode.test.ts` fails if a library upgrade ever fixes it. Now libvips
makes every ladder cell and decodes every page; the canvas library only
assembles and encodes.

## Stage 2 — ranks

**Test:** rank rebuild at a million images in 2 s or less.

The order of a sort is now one value (`board_rank_state.slot_order`, 4
bytes per slot) instead of a million rows in `board_ranks`. One board of
1,000,000 generated rows, three runs each:

| | `board_ranks` | `slot_order` |
| --- | ---: | ---: |
| rebuild `name.asc` | 3.7–6.0 s | 0.10–0.12 s |
| rebuild `uploaded_at.desc` | 1.5–4.3 s | 0.26 s |
| rebuild `p.number.year.asc` | 4.6–5.6 s | 0.98–1.02 s |
| first read of an order | — | 25–41 ms |
| `slotsForTile`, z = −5 | — | 0.13 ms |
| find `'a'` (872,133 matches) | — | 0.67 s |
| find `name LIKE 'a%'` via join | 4.9 s | — |
| sections, first / repeat | — | 0.4–1.4 s / 0 ms |

The `board_ranks` column was measured while another run loaded the
machine; the ratio, not the absolute time, is the finding. A narrow find
still takes ~1.2 s: the text filter scans every property with
`jsonb_each_text`, which is unrelated to ranks.

## Stage 3 — ingest

Libvips decodes originals (a 2048² JPEG ladder decode: 14.1 → 4.6 ms; PNG
unchanged at ~19 ms), EXIF becomes captured properties, and ladder jobs are
painted a page at a time (`jobs.ts#planUnits`). The same 20,001-file import:

| | before | after |
| --- | ---: | ---: |
| all accepted | 412 s | 143–250 s |
| all ready | 840 s | 268–277 s |

At the old upload limit (6,000 files a minute) a fast import drew 7–66
429s, retried by the client; processing was slower than the limit, so it
cost no time.

**Folder import** (`POST /boards/:id/imports {path}`): off until the
operator sets `IMPORT_ROOTS`; a path is resolved with realpath and must lie
inside a root (a symlink out of a root is refused). The owner's 141
screenshots imported in one run, 0 skipped; `/etc` was refused with 403.
The upload rate limit rose to 12,000 files a minute, above what the worker
processes, so an import no longer meets it.

## Stage 4 — meaning

CLIP ViT-B/32, 8-bit weights, through transformers.js under Bun, off by
default (`EMBEDDINGS=on`). Vectors are stored as pgvector `halfvec(512)`
with one HNSW index (`0020_embeddings_pgvector.sql`); the Postgres image
builds pgvector 0.8.6 on the same Alpine base (`db/Dockerfile`), so the
existing volume and its indexes carried over unchanged.

| | value |
| --- | ---: |
| embed one image (model loaded) | 74.8 ms |
| worker RSS with the image model | +~400 MB |
| HNSW build, 1,000,000 vectors | 2 min 15 s, 1.3 GB |
| search, 1,000,000 vectors, 150 / 20 results | 8 ms / 2 ms |
| search, a 150-image board beside them | 5 ms, all 150 |
| first text search (loads the text model) | 2.9–3.2 s |
| the brute-force scan it replaced, 1,000,000 | 2.15 s |

**Quality**, on the owner's 141 screenshots (maps, street photos, flow
charts, graphs, dialogs, a painting), imported through the folder import
and searched through `GET /boards/:id/search`:

| query | top three |
| --- | --- |
| a map | 3 of 3 maps |
| a photo of a building on a street | 3 of 3 street photos |
| an error message dialog | the error dialog first; then 2 terminals |
| a flowchart diagram | 3 of 3 flow charts |
| a painting of a person | the painting first; then 2 misses |
| a login screen | the lock screen second; 2 misses |
| a network graph of connected nodes | 3 of 3 graphs |

The first result was right for 6 of 7. Scores are low and close together
(0.23–0.31), so results are ranked, never cut at a threshold.

## Stage 5 — more than one process

**Test:** one API process (`WORKER=off`) and two independent worker
processes on one board, a 20,000-file import, then a pixel audit
(`server/scripts/audit-ladder.ts`) that every ready image is painted at all
three ladder sizes.

| | value |
| --- | ---: |
| all ready | 166 s |
| job failures | 0 |
| blank cells | 0 of 60,003 |

Filesystem storage stood in for S3: a rename overwrites like a `put`, so a
lost update would show the same way. One API process, not two; composed
tiles and coarse tiles invalidate across processes through `LISTEN/NOTIFY`
(`invalidation.test.ts` covers that boundary directly).

## Stage 6 — operations

Decided with the owner, 2026-09-23:

- **Metrics:** `/metrics` gains RSS per process (API, worker), worker exits
  split into retired and crashed, and the rank-order cache.
- **Quotas:** not per group yet. The failure a small self-hosted group meets
  is a full disk, so uploads stop (507) while the data volume has less than
  `UPLOAD_MIN_FREE_GB` free (default 5; `storage/room.ts`), on the one
  ingest path every upload and import takes. A folder import pauses on it
  and resumes on the same file.
- **Tracing:** no OpenTelemetry. One host and no collector: `Server-Timing`,
  JSON request logs and `DIGSITE_REQUEST_DIAGNOSTICS` already answer where
  time goes.
- **Backups:** `deploy/backup.sh` as before, minus the downloadable model
  weights, plus retention (`BACKUP_KEEP`, default 14) and a cron line.
