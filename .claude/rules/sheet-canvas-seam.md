---
scope: web/src/sheet/**
tags: [sheet, excalidraw, seam]
priority: high
source: hand-written
checks:
  - forbid: 'from ''@excalidraw/'
    in: web/src/**
    except: web/src/sheet/canvas/
    message: imports Excalidraw outside web/src/sheet/canvas/; go through CanvasHandle
  - forbid: 'ExcalidrawElement|ExcalidrawImperativeAPI'
    in: web/src/**
    except: web/src/sheet/canvas/
    message: an Excalidraw type crossed the canvas seam; use SceneElement and CanvasHandle
---

# sheet: Excalidraw lives in `canvas/` and nowhere else

`web/src/sheet/canvas/` is the one module that imports
`@excalidraw/excalidraw`. Its interface is `Canvas` (a component) and
`CanvasHandle` (a handful of imperative calls), and the only types that
cross it are ours: `SceneElement`, `Viewport`, `ScenePatch`, `Tool`.
The tools, the socket room, the overlay, the inspector and the page
talk to the canvas through that handle and never see an Excalidraw
element.

Decided 2026-09-22 after using the app: the sheet read as "Excalidraw
with extras" — its properties panel, menu, library, help, footer and
hand-drawn font on screen beside our toolbar. Every one of those is a
setting or a wrapper inside `canvas/`, and the rest of the product must
not be able to reach past it, or the chrome comes back one convenience
at a time.

## What must stay true

- **No `@excalidraw` import outside `canvas/`.** The seam linter fails
  the build on one.
- **No Excalidraw type outside `canvas/`.** `SceneElement` is the
  product's element; `canvas/convert.ts` is the only translation.
- **History is decided at the seam.** `apply(..., {history: false})`
  and `applyRemote` never enter undo; the caller does not know
  `CaptureUpdateAction` exists.
- **Stock chrome is off by configuration, inside `canvas/`.** One CSS
  override is tolerated there, with the Excalidraw version it works
  around in its comment, and none anywhere else.
- **The foreign overlay stays outside the canvas**
  (`foreign-never-in-scene.md`); the canvas draws own elements only.

Verify with `bun run lint:seams`, `cd web && bun test canvas.test.ts`,
and a screenshot of a sheet with an edge selected showing only our
toolbar, our side panel and the drawing.
