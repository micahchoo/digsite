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
