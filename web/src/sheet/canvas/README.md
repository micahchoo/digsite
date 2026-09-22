# canvas/ — the module that owns Excalidraw

The one **seam** (`codebase-design`) between the sheet's product UI and
Excalidraw. `Canvas.tsx` is the **adapter**: a component plus a
`CanvasHandle` ref. `SceneElement`, `Viewport`, `ScenePatch` and `Tool`
(`types.ts`) are the only shapes that cross it; `convert.ts` is the only
place that turns one into an Excalidraw element or back. No file outside
this directory imports `@excalidraw/*` or names an Excalidraw type —
`bun run lint:seams` fails the build on either.

## Interface facts a caller must know

- `apply(patch, {history: false})` and `applyRemote` never enter undo — the
  caller does not know `CaptureUpdateAction` exists.
- `apply`'s `addRegion`/`addEdge` ops carry the new element's `id`, chosen
  by the CALLER (`tools.ts`'s `newId()`); `apply` returns `void`.
- `elements()`/`selectedIds()` are live reads at call time, never a cached
  copy of the last `onChange`.
- Pointer coordinates elsewhere in the sheet are already scene coordinates.
- `zoomBy`/`zoomToFit` fit against the canvas's own container size, private
  to this module.

## What hid the stock chrome

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
