# Bulk upload feedback — 2026-09-22

The user reported two selections of 20,000 files with no visible result on
the real preview at port 5292. A later small selection worked.

## Findings

- The old UI mounted one DOM row per file: 20,000 rows for one selection.
  Its Playwright `setInputFiles` action took about 2.8 seconds. There was no
  separate measurement of input-event-to-feedback latency in that run.
- Processing checks searched the newest 500 images. Accepted images outside
  that window could never be confirmed by that lookup.
- Resumable completion did not return the accepted image ID to the browser.
- Tus request logging registered its completion listener after awaiting the
  handler. A completed PATCH could therefore be absent from the request log.
- The inspected preview database held 104 ready images and no queued jobs.
  This does not establish what happened to either historical 20,000-file
  attempt. No complete request trace of those attempts was available.

## Changes

Each board has an in-memory queue that survives route changes. The shell
links to boards with pending work or errors. The activity panel shows queued,
uploading, processing, ready, failed, unconfirmed and canceled counts.
It mounts at most 80 file rows and releases File references after acceptance,
rejection or cancellation. Dismissing completed activity clears its history.

The transfer pool permits at most two requests across all boards. Multipart
batches contain at most ten files. Files over 8 MiB use resumable transfers.
Rate-limit responses show a retry countdown. Ambiguous upload results are
not automatically resubmitted. Stopping queued uploads lets active transfers
finish; signing out stops local queues. Reloading loses queued file handles,
so the browser warns while files are queued or uploading.

Processing status uses an access-controlled endpoint for at most 500 explicit
image IDs per request, independent of rank and the newest-images window.
The final Tus response exposes `Upload-Image-Id`. Tus completion logging is
registered before the handler starts. Existing abuse limits remain in force.

## Verification

- Isolated browser test: two 20,000-file selections, 80 mounted rows, at most
  two held upload POSTs. Feedback appeared 142 ms and 119 ms after the input
  change event. Total Playwright input calls took 2.21 s and 2.17 s, including
  protocol/file-object overhead. These are not evidence of a 20× speedup.
- That test also checks route navigation, the shell indicator, stopping queued
  work and visible errors. It does **not** ingest 40,000 images into storage.
- Real browser/server test: 13 multipart images and one image over 8 MiB
  complete processing, appear exactly once and show `14 ready` in the UI.
- Server tests check status IDs beyond the newest 500, access boundaries,
  malformed/oversized requests, Tus response headers and PATCH logging.
- Queue tests check bounded concurrency, stopping followed by a new selection,
  rate-limit retries, releasing files and avoiding retries after an ambiguous
  write result.

Reproduce with `bun run smoke scripts/smoke-upload-scale.ts` and
`bun run e2e:fresh src/upload-queue.ts` from `app/`.

Large-batch throughput and long-lived server processing at 20,000 real images
remain separate measurements. Current rate limits deliberately bound ingest.
An interrupted resumable upload may leave partial server staging data; this
pass does not add a staging-retention sweeper.
