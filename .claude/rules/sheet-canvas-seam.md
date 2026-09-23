---
scope: web/src/sheet/**
tags: [sheet, canvas, seam]
priority: high
source: hand-written
checks:
  - require: "from './native/index.ts'"
    in: web/src/sheet/canvas/Canvas.tsx
    message: Canvas must use the native implementation
  - forbid: '(@excalidraw|Excalidraw)'
    in: web/src/**
    flags: i
    message: active web source still refers to the removed drawing engine
  - forbid: 'VITE_CANVAS|[?&]canvas=(native|excalidraw)'
    in: [web/src/**, web/test/**, web/scripts/**, scripts/**]
    flags: i
    message: obsolete canvas selection switch remains in active code
---

# Sheet canvas boundary

`web/src/sheet/canvas/` owns the drawing surface. Product UI, tools, room
synchronization and the foreign overlay communicate with it through
`Canvas`, `CanvasHandle` and the product-owned scene types. Native rendering
and input behavior live under `canvas/native/`.

The persisted scene format remains compatible with records created by older
canvas versions. Keep structural fields such as bindings, group identifiers,
points and arrowheads when reading, merging or writing saved elements.

## What must stay true

- The active canvas implementation is native and the production bundle does
  not include a third-party drawing engine.
- Remote scene changes do not enter local undo history.
- The foreign overlay stays outside the owned scene and its persistence.
- Shared persisted scene fields remain readable across reloads.

Verify with `bun run lint:seams`, `cd web && bun test`, and a production build.
