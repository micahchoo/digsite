# The two fenced canvas defects, against the latest release — 2026-09-23

Correctness investigation C7. Two `@napi-rs/canvas` defects are fenced in
`server/`. Each was tested standalone under Node, outside the app, on
0.1.100 (installed) and 1.0.9 (latest).

## The decoder that rejected its own PNG: fixed in 1.0.9

`server/src/test/fixtures/page-canvas-cannot-read.png` is a ladder page
that the library encoded itself.

```js
import { readFileSync } from 'node:fs';
import { loadImage } from '@napi-rs/canvas';
await loadImage(readFileSync('page-canvas-cannot-read.png'));
```

| version | `loadImage` | `new Image().src` |
| --- | --- | --- |
| 0.1.100 | throws "Invalid SVG image" | same |
| 1.0.9 | 512×512 | 512×512 |

On 1.0.9 the decoded page matches libvips on every one of its 1,048,576
channel values. The same holds under Bun. There is nothing to report
upstream. `ladder.ts#decodePage` still decodes with libvips, which costs
nothing, so that fence stays. The first test in `page-decode.test.ts`
("the canvas library still cannot read this page") will fail on an
upgrade. That failure is the signal, and the test can go then.

Upgrading 0.1 → 1.0 is not done here. The library sits on the hot path,
and its memory was measured with soaks (`tile-cache-is-for-the-second-viewer.md`).
An upgrade must run those again.

## The resize that grew RSS: not reproduced outside the app

`canvas-holds-its-sources.md` says that resizing the page canvas before
each paint grew RSS by ~1.1 MB per image. The standalone loop copies the
paint path step for step: optional resize, `getContext`, `fillRect`, the
stored page with `putImageData`, one cell, `encodeSync('png')`.

| version | 3,000 cycles, no resize | 3,000 cycles, resize each time |
| --- | ---: | ---: |
| 0.1.100 | +16 MB | +16 MB |
| 1.0.9 | +19 MB | +17 MB |

At 1.1 MB per cycle, the resize column would read about +3,300 MB. The
library alone does not leak on these calls. The trigger is something the
app adds: `loadImage` of the stored page (the path before `decodePage`),
the worker's other canvases, or concurrency. Nobody knows which, so
there is no upstream report. The `willEncode` fence stays. Bisect with
`scripts/repro-paint-ladder-import.ts` by removing one step at a time.

## The upgrade, measured (2026-09-23, later): not taken

Both harnesses, 0.1.100 against 1.0.9. Page churn holds flat on both
(+2 MB, +1 MB). The paint-and-read import harness passes its own limit
(under 128 MB at 600 images) on both versions: +56 and +48 MB on 0.1.100,
+83 and +108 MB on 1.0.9. Run to 1,500 images, though, neither version
levels off:

| RSS | 300 | 600 | 900 | 1,200 | 1,500 | per image |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 0.1.100 | 235 | 269 | 291 | 317 | 344 MB | 0.09 MB |
| 1.0.9 | 265 | 301 | 348 | 399 | 442 MB | 0.15 MB |

1.0.9 leaks about 60% faster on the paint path, so the decode fix (which
the libvips fence already covers) does not pay for it. The upgrade is not
taken.

The same table shows a problem on the current version: a steady 0.09 MB
per painted image, about 1.8 GB over a 20,000-file import. The
harness's "under 128 MB at 600" hides it. Today the worker's retirement
at WORKER_RSS_LIMIT_MB (worker-is-disposable.md) contains it. Roadmap
C11 tracks it: bisect by removing one step of the harness at a time, and
judge by the slope from 300 to 1,500, never by the delta at 600.
