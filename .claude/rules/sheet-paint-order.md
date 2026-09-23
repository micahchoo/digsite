---
scope: web/src/sheet/**
tags: [sheet, canvas, z-order, merge]
priority: high
source: hand-written
checks:
  - require: 'paintOrder\(elements\)'
    in: web/src/sheet/canvas/native/render.ts
    message: render.ts must paint through scene.ts#paintOrder, never raw array order
  - require: 'edgePaths\('
    in: web/src/sheet/canvas/native/render.ts
    message: render.ts must draw connections along routing.ts#edgePaths, the path hitAt measures
  - require: 'edgePaths\('
    in: web/src/sheet/canvas/native/scene.ts
    message: hitAt must measure connections along routing.ts#edgePaths, the path render.ts draws
---

# sheet: a saved scene's order is not a z-order

The native canvas never assigns a fractional `index`; that was an
Excalidraw field. Until 2026-09-23, `shared/src/sheet/merge.ts` sorted
unindexed elements by id on every save. Edges and regions carry random
uuids, so they sorted before their images, and every reload drew each
claim under its own picture. It was invisible during a live session,
because the in-memory order was still right.

## What must stay true

- **Paint by kind: images, then regions, then edges.** `render.ts` walks
  `scene.ts#paintOrder`; within a kind, array order decides.
- **The hit test asks in the reverse of that order.** `scene.ts#hitAt`
  checks edges first, then regions, then images; `sheet/hit.ts` prefers a
  region over the image under it. A line drawn across an image is what a
  click on it selects, because that is what the frame showed on top.
- **A connection is drawn border to border, never across its own ends.**
  `@digsite/shared#clipPath` trims it out of the image or region at each
  end. Drawn centre to centre and on top, a line took every click on the
  images it joins; on the overlay that meant an image another sheet had
  connected could not be selected at all (found 2026-09-23 by the
  real-server walk, `e2e/src/sense-claims.ts`).
- **A connection goes around the pictures between its ends.**
  `sheet/routing.ts#edgePaths` is the one answer to "what is this line
  drawn along": the canvas strokes it, `hitAt` measures it, the overlay
  puts the relation label on its middle segment. Cached per elements
  array, so a pan computes nothing. Its A* search state is a node AND the
  axis it arrived on; keyed by node alone it returned three bends where two
  do. Other sheets' lines go around by the same rule through
  `routing.ts#foreignPaths` (both call `routeAround`); the overlay draws
  that polyline and puts the label on its middle segment, so the SVG's own
  hit area is what was drawn. `foreignShapes` carries the ends' rects and
  no line of its own.
- **The merge never reorders by id.** Unindexed elements keep their stored
  order and new ones follow (the sort is stable). An element with an index
  still sorts by it.

Verify with `cd web && bun test native-scene screen routing`, `cd shared && bun
test merge segment`, and `bun run e2e:fresh src/sense-claims.ts`, which clicks, after a
reload on the real server, a routed line where it was drawn, the picture
it goes around, and the pictures it joins.
