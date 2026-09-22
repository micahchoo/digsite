# canvas/ — the module that owns the sheet's drawing surface

The one **seam** (`codebase-design`) between the sheet's product UI and
whatever actually draws the scene. `Canvas.tsx` is a switch between two
**adapters**, both satisfying `CanvasProps`/`CanvasHandle` (`types.ts`):
`excalidraw/` (the shipped default, wrapping `@excalidraw/excalidraw`) and
`native/` (image-graph's own camera/gestures/scene/history mechanisms,
ported to canvas 2D, no third-party drawing library). `SceneElement`,
`Viewport`, `ScenePatch` and `Tool` are the only shapes that cross the seam
either way; no file outside this directory imports `@excalidraw/*` or names
an Excalidraw type, and no file outside `native/` reaches into that
adapter's own internals — `bun run lint:seams` fails the build on the
former.

## Switching adapters

`VITE_CANVAS=excalidraw|native` (env, read at build/dev-server start) picks
the default; `?canvas=native` or `?canvas=excalidraw` on a sheet URL
overrides it for that page load. `excalidraw` is the default until the
native adapter has fully proven itself in production use.

## Interface facts a caller must know (both adapters)

- `apply(patch, {history: false})` and `applyRemote` never enter undo — the
  caller does not know either adapter's internal history representation.
- `apply`'s `addRegion`/`addEdge` ops carry the new element's `id`, chosen
  by the CALLER (`tools.ts`'s `newId()`); `apply` returns `void`.
- `elements()`/`selectedIds()` are live reads at call time, never a cached
  copy of the last `onChange`.
- Pointer coordinates elsewhere in the sheet are already scene coordinates.
- `zoomBy`/`zoomToFit` fit against the canvas's own container size, private
  to the mounted adapter.
- The persisted element JSON is shared, not adapter-specific: either
  adapter can open a scene the other saved, with every claim (region, edge,
  label) in place — `web/test/canvas-roundtrip.test.ts`.

## `excalidraw/` — what hid the stock chrome

The installed 0.18.1 has no single "no stock UI" flag (that's a newer,
unreleased `ui` prop some docs describe — checked and ruled out against
the installed `types.d.ts`). Three mechanisms: `UIOptions.canvasActions`
all `false` and `tools.image: false` remove every menu/toolbar command; an
empty `<MainMenu />` child replaces the default items with none;
`canvas.css` hides what nothing in this version's API reaches — the shapes
toolbar and properties island (`.App-menu_top`), the footer
(`.layer-ui__wrapper__footer`, since we build our own zoom/undo), and the
menu/library trigger buttons. No `<WelcomeScreen>` child is rendered, so
its tunnel stays empty. Verified against a running sheet with an edge
selected (`web/screenshots/sheet-product.png`).

Labels: plain sans (`FONT_FAMILY.Helvetica`), `roughness: 0`, solid
stroke/fill — set directly on every element `convert.ts` builds, not
through `initialData.appState`'s `currentItem*` (which only seeds elements
drawn through Excalidraw's OWN tools; nothing here is).

## `native/` — image-graph's mechanisms, ported

`camera.ts` (viewport arithmetic, `zoomAt`/`fitBox`/`wheelGesture`),
`gestures.ts` (`pressIntent`/`dragBecomes`, total over the two modes this
canvas's own pointer handling ever sees — `select`/`pan`; `region`/`edge`
are `DrawLayer.tsx`'s, shared with the excalidraw adapter and unchanged),
`scene.ts` (the spatial index, the hit test that measures what `render.ts`
actually drew, edge retargeting), `spatial.ts` (the uniform grid), `ops.ts`
(building a region/edge, applying a patch), `history.ts` (per-element
before/after steps; undo/redo bump `version` past whatever the id holds so
the restored content wins the next `mergeByVersion`), `images.ts` (a
decoded-bitmap cache keyed by fileId), `render.ts` (one frame). No
`@excalidraw` import anywhere in this directory.

`NativeCanvas.tsx` is the only file that owns DOM events and React state;
everything else here is plain, DOM-free, and unit-tested directly
(`web/test/native-*.test.ts`) — the same split `image-graph-hit-what-was-drawn.md`
and `image-graph-exploration-seam.md` describe for that plugin's own canvas.
A screenshot of a sheet with an edge selected, native, is
`web/screenshots/sheet-native.png`.
