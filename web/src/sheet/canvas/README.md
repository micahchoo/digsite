# canvas/ — the sheet drawing surface

`Canvas.tsx` exposes the native canvas through the stable `CanvasHandle` and
`CanvasProps` contract in `types.ts`. The product passes scene elements,
viewport changes and patch operations through that contract; native drawing,
camera, gestures, hit testing, history, image loading and rendering live in
`native/`.

`SceneElement`, `Viewport`, `ScenePatch` and `Tool` are product-owned shapes.
The persisted scene also accepts legacy-compatible fields such as bindings,
group identifiers, points and arrowheads because existing saved documents may
contain them. Foreign claims remain in the separate overlay and never enter
the owned scene.

The canvas handle keeps history decisions inside the canvas: `apply` with
`history: false` and `applyRemote` never enter undo. Patch IDs come from the
caller, and element reads return the current scene. Pointer coordinates used
by sheet tools are scene coordinates; zoom-to-fit uses the mounted canvas
size.

`native/` contains the implementation. `NativeCanvas.tsx` owns DOM events and
React state. Camera, gestures, scene operations, history, image decoding and
frame rendering are kept in small modules that can be tested without a
browser. `bun run lint:seams` checks the sheet module boundaries.
