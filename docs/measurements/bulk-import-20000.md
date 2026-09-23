# A real 20,000-image import — 2026-09-22

Roadmap item 1 asks for a real 20,000-photo import with timing, memory and
failure tracking, and for the historical OOM to be resolved or reproduced.
One import did both: it passed 16 GB, and the cause is a native-memory leak
in the upload worker's ladder paint.

## The run

`e2e/src/import-real.ts` selects every image in a folder through the board's
real upload input in headless Chromium. It samples the UI's counts, the
database's image and job counts, the server's RSS and high-water mark, and
the browser's summed RSS every 5 s. It stops when the database accounts for
every file.

- **Files**: 20,001 PNGs from the image-graph development vault
  (`obsidian-developing-plugins/Image vault`). 20,000 are generated
  2048×2048 illustrations of 38–102 KB; one is a 1693×1408 screenshot of
  1.4 MB. They are real files through the real path, but they are not
  camera JPEGs: they decode at full 2048² cost and transfer small.
- **Server**: an isolated instance on a fresh database
  (`digsite_import_1790136976`), filesystem storage on the disk array,
  default limits and `WORKER_CONCURRENCY=4`, request diagnostics on.
- **Machine**: 32 cores, 122 GB RAM, no memory cap on the process.

## Before the fix

| | value |
| --- | --- |
| selection (`setInputFiles`) | 1,444 ms; counts visible at 1,487 ms |
| all 20,001 accepted | 412 s (~49 files/s) |
| all 20,001 ready | 840 s (~24 images/s) |
| failures | 0 failed images, 0 page errors, 20,001 rows / 20,001 names |
| upload responses | 2,001 multipart `202`, 0 rate-limited, 0 `413` |
| server RSS | 24.2 GB at the end, rising the whole run |
| browser RSS (all Chromium processes) | 1.2 GB peak; page JS heap 58 MB flat |

521 `GET` requests were aborted by the page. These are tile and preview
requests cancelled when the board reloads its tiles; no upload request failed.

Server RSS grew linearly with **processed** images, not accepted ones. After
the last upload was accepted at 412 s, it kept climbing at the same slope:

| t | accepted | ready | server RSS |
| ---: | ---: | ---: | ---: |
| 5 s | 432 | 150 | 1.2 GB |
| 188 s | 10,710 | 4,588 | 6.4 GB |
| 412 s | 20,001 | 9,978 | 12.6 GB |
| 514 s | 20,001 | 12,306 | 15.3 GB |
| 575 s | 20,001 | 14,018 | 17.1 GB |
| 840 s | 20,001 | 20,001 | 24.2 GB |

That is ~1.14 MB per processed image. A process capped at 16 GB is killed
at about 13,000 images, which matches the two historical 20,000-file
attempts and the two 16 GB kills in the journal. Neither historical
attempt left a trace, so this shows a mechanism that produces them and
not proof that it was their cause.

## The cause

`@napi-rs/canvas` keeps every source drawn into a canvas until that canvas
is encoded or resized. `getImageData` does not release them. With no files,
decode or storage involved, 900 cycles of "fill a 512² canvas, draw it into
another canvas" grew RSS by 905 MB; encoding or resizing the destination
each cycle held it flat. The same holds on 0.1.100 (installed) and 1.0.9
(latest), so an upgrade does not remove it.

`ladder.ts#loadPageCanvas` resized every page canvas it loaded, to stop the
pan-path leak (a `getPage` canvas is never encoded, so it holds the page it
last loaded until it is resized). `paintLadder` goes through the same
function three times per upload. It encodes every page it paints, which
already releases what it drew, and the resize there leaked ~1.1 MB per
upload. Why that resize leaks is not known. Both paths are now gated by a
harness:

| `loadPageCanvas` resizes | paint + tile read, 550 images | pan churn, 250 loads |
| --- | ---: | ---: |
| always (before) | **+623 MB, fails** | +32 MB |
| never | +37 MB | **+255 MB, fails** |
| read path only (shipped) | +19 MB | +21 MB |

Reproduce from `server/`:

```sh
DATA_DIR=$(mktemp -d) bun run scripts/repro-paint-ladder-import.ts "<image folder>" 600
prlimit --data=2147483648 -- env LADDER_BUDGET_MB=0 bun run scripts/repro-ladder-page-churn.ts 250
```

Each fails above 128 MB of growth. The first reads each painted page back
through `withPage` and encodes a tile from it, as an open board does.

## After the fix

The same 20,001 files into a new board on the same database, after
restarting the server on the fixed code:

| | before | after |
| --- | ---: | ---: |
| selection / counts visible | 1,444 / 1,487 ms | 1,313 / 1,353 ms |
| all accepted | 412 s | 250 s |
| all ready | 840 s | 799 s |
| failures, page errors, rate limits | 0 / 0 / 0 | 0 / 0 / 0 |
| rows / distinct names | 20,001 / 20,001 | 20,001 / 20,001 |
| server RSS at 4,588 ready | 6.4 GB | 1.5 GB |
| server RSS at 9,978 ready | 12.6 GB | 2.0 GB |
| server RSS at 14,018 ready | 17.1 GB | 2.2 GB |
| server RSS peak | 24.2 GB | 2.9 GB |
| server RSS idle after | 24.2 GB | 2.1 GB |
| browser RSS peak | 1.2 GB | 1.0 GB |

The remaining growth is resident ladder pages, which `LADDER_BUDGET_MB`
bounds; it rose and fell within the budget rather than tracking the image
count. Acceptance ran faster too, which is consistent with less memory
pressure but was not isolated.

## What this does not cover

- **The native file dialog.** Playwright's `setInputFiles` bypasses the
  operating system's chooser, so the reported dialog delay is still
  unmeasured. It needs a person at the machine.
- **Camera photos.** Larger JPEGs move more bytes per file. Every file
  here was under 8 MiB, so no file took the Tus path.
- **The compact grid at a million images.** This board is 20,001 images.
