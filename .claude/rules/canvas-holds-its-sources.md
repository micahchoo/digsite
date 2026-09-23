---
scope: [server/src/boards/**, server/src/worker/**, server/scripts/repro-ladder-page-churn.ts, server/scripts/repro-paint-ladder-import.ts]
tags: [canvas, memory, ladder, tiles, upload]
priority: high
source: hand-written
---

# server: a canvas holds every source drawn into it until it is encoded or resized

`@napi-rs/canvas` (0.1.100 installed, 1.0.9 latest, same result) keeps a
reference to every `Image` or `Canvas` drawn into a canvas until that canvas
is encoded (`encodeSync`) or its `width`/`height` is assigned.
`getImageData` releases nothing, and neither does a forced GC. Measured
2026-09-22 with no files or storage: 900 cycles of "fill a 512² canvas, draw
it into a 256² canvas" grew RSS by 905 MB; encoding or resizing the
destination each cycle held it flat.

So every reused destination canvas needs an answer to one question: **what
releases its sources?**

- **Encoded every use** (`tiles.ts#composeTile`, `paintLadder`, the worker's
  resize): released by the encode. Do not also resize it.
- **Never encoded** (a `getPage` canvas, read only as a draw source):
  `loadPageCanvas` resizes it on reuse. Without that, pan churn grows
  ~1 MB per page load.

## The resize is not free

On the paint path, resizing the page canvas before each paint grew RSS
~1.1 MB per uploaded image, and nobody yet knows why. A 20,000-image import
reached 24 GB on it and would have been killed at a 16 GB cap near 13,000
images (`docs/measurements/bulk-import-20000.md`). That is why
`loadPageCanvas` takes `willEncode`, and why "just always resize" is wrong.

## What must stay true

- A new canvas that is drawn into and reused says, in a comment, whether an
  encode or a resize releases it.
- A leak probe must do what production does. A probe that reads a tile with
  `getImageData` and never encodes it reports a leak `tiles.ts` does not have.

Verify from `server/` with both harnesses; each fails above 128 MB:

```sh
DATA_DIR=$(mktemp -d) bun run scripts/repro-paint-ladder-import.ts "<image folder>" 600
prlimit --data=2147483648 -- env LADDER_BUDGET_MB=0 bun run scripts/repro-ladder-page-churn.ts 250
```
