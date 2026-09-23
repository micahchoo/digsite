# Bulk import throughput — 2026-09-22

The user reported slow uploads, a blinking board and a slow file picker.
The earlier large-selection test measured queue rendering, not ingest speed.

## Observed bottlenecks

The real preview log contained 164 multipart requests: 87 accepted and 77
rate-limited. Accepted batches of ten commonly took 36–88 ms. After the
initial burst, a batch was accepted about once every five seconds. The
configured default was 120 files/minute: roughly three hours for 20,000 files,
regardless of available storage speed.

The processing worker also polled at a fixed 500 ms interval. Four quick
jobs left the worker idle until the next tick. Slow batches could overlap
subsequent interval ticks, so the configured concurrency was not a true bound.

## Processing measurements

`server/scripts/bench-ingest.ts` generates distinct 640×480 PNGs, accepts
them through `uploadOne`, then starts the real worker and waits for every
image to become ready. Storage is local filesystem; PostgreSQL uses a
disposable database. Acceptance includes image generation and PNG encoding.
It excludes browser/network costs and is not a large-photo benchmark.

| Worker | Images | Acceptance | Processing | Peak RSS |
| --- | ---: | ---: | ---: | ---: |
| Fixed interval | 120 | 1.03 s | 15.10 s | 197 MB |
| Consecutive bounded batches | 120 | 1.08 s | 1.90 s | 312 MB |
| Consecutive bounded batches | 1,200 | 10.42 s | 21.36 s | 425 MB |

The revised worker runs one bounded batch at a time, yields to the event
loop between busy batches, and waits 500 ms only when no jobs are due.
It does not raise decode concurrency. Tests hold a slow batch open to
verify no overlapping polls, verify immediate continuation when work remains,
and verify that stopping prevents another poll.

Default authenticated-user limits are now 6,000 files/minute and 600
resumable-upload creations/minute. Both remain configurable. Existing
explicit deployment overrides remain authoritative. Size, pixel, access
and rate-limit enforcement still apply. Processing is asynchronous: a fast
transfer does not imply all previews are already built.

Multipart bodies are now limited while streaming, before parsing or copying
individual files. The default aggregate limit is 100 MiB, configurable with
`UPLOAD_BATCH_MAX_MB`; a request may contain at most 100 files. The browser
queue sends at most ten files of at most 8 MiB in each multipart batch, so
normal bulk imports remain below both bounds. Larger files use Tus.

## Reproduction

Create and migrate a throwaway database whose name starts with
`digsite_ingest_`, and set `DATABASE_URL` and a disposable `DATA_DIR`.
From `server/`, run `BENCH_IMAGES=1200 bun run scripts/bench-ingest.ts`.
Drop that database and remove its storage afterward. The script refuses
database names outside that prefix.

The real browser upload acceptance check now sends 133 small images and
one resumable image. It checks completion, unique images and absence of
rate-limit pauses at this ordinary bulk-import size.

The two historic 20,000-file attempts remain unconfirmed. These measurements
do not claim successful ingestion of a 40,000-photo library or reproduce
native operating-system file-dialog drawing latency.
