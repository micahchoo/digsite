---
scope: [web/src/sheet/Sheet.tsx, web/src/sheet/actions.ts, web/src/sheet/beside.ts, web/src/sheet/evidence.ts]
tags: [sheet, seam, extract]
priority: medium
source: hand-written
---

# web: the sheet's multi-step work lives in actions.ts, not the view

`sheet/actions.ts#createSheetActions` holds every sequence the sheet runs
over more than one step: bring a picture beside another (wait for it to
arrive through the room, then place it), connect from "Looks like",
extract a region into a picture (crop, wait for the worker, bring, connect
"derived from", select), and copy the connections Explore hands a new
sheet (by imageId). A report is NOT gathered here since 2026-09-23: the
server gathers it (`server/src/reports/gather.ts`), because only the server
sees the board's other sheets.

It takes a narrow port: the scene's `elements()` and `select()`, the
tools' `moveImage` and `connect`, three api calls and a `wait`. `NativeCanvas`'s handle is the production adapter;
`test/sheet-actions.test.ts` has an in-memory scene and a fake server
whose added pictures arrive after some waits. Two adapters: a real seam.

Why: until 2026-09-23 these ran inside `Sheet.tsx`, which no test can
construct. The pure pieces (`beside.ts`, `evidence.ts`) were
tested; both defects found that week were in how the view called them
(`besideSpot` measured the element's own position; a picture without
`groupIds` crashed the move).

## What must stay true

- **A new sequence goes in actions.ts**, and the view only reads the
  pointer, says progress (`say`) and does DOM work (the download).
- **Do not widen the port to the whole `CanvasHandle`.** Fifteen methods
  for two used is how a fake stops being written.
- **`wait` is injected.** A test that sleeps for real to cover the
  arrival loop is 10 s long; the fake counts ticks.

Verify with `cd web && bun test sheet-actions beside evidence`,
then `bun run e2e:fresh src/sense-claims.ts` (extract, Looks like).
