# What image-graph already solved

Studied 2026-09-23 from `obsidian-developing-plugins/image-graph` (source,
docs, screenshots). Each pattern names where it lives there, what digsite
does today, and what to do. "Horizon" refers to the roadmap in
`docs/roadmap.md` § "Making sense — six horizons".

## Lines and labels: say which two things are joined

1. **Route around, never across.** `routing.ts#routeOrthogonal`: an
   orthogonal path around every unrelated image between the ends, A* on the
   grid of obstacle edges, a turn penalty so fewer corners win, and a
   straight line when the detour passes 2.4x the direct length. Off above
   240 lines on screen, below scale 0.06, and during a drag. Corners are
   rounded (`canvas-renderer.ts#strokePath`); an arrowhead follows the last
   segment. The hit test measures the routed path (`distanceToPath`).
   *digsite:* lines clip to their ends' borders but still cross other
   pictures. **Adopt. Horizon 1.**
2. **Focus decides emphasis.** `presentation.ts#connectionStyle`: a line is
   emphasised when selected, hovered or on the traced path; relevant when
   adjacent to a selected or hovered image or matching the filter; faint
   otherwise (.3, .14 while exploring, .09 when filtered out). Labels only
   on emphasised or relevant lines. *digsite:* every label always drawn;
   only relation emphasis dims. **Adopt. Horizon 1.**
3. **Labels are placed last and may be hidden.** `drawLabels`/`labelBox`:
   after every line, by priority (selected, path, rest), trying seven points
   along the line and two steps either side, clear of images, captions and
   earlier labels; none free means no label. *digsite:* the overlay avoids
   collisions for connection and foreign-region labels. **Keep; add the
   priority and the relevance rule.**
4. **Regions stay faint until relevant.** Alpha .12 (.2 on a starting
   image) unless selected, hovered, or at the end of a relevant line.
   *digsite:* every region full strength, and its label is not on the
   canvas at all. **Adapt: faint by default, label shown when lit.
   Horizon 1.**
5. **Captions under pictures.** Name under each image when it is 60 screen
   pixels wide and the caption box is free; a `Starting image` badge;
   ` · pinned`. Extracted images read `Region · Parent`. *digsite:* no
   captions on the sheet. **Adopt. Horizon 1.**
6. **A group reads as a group.** Several selected: thinner rings plus one
   dashed band around all. **Adopt. Horizon 1.**
7. **Grips only where grippable** (image wider than 48 screen pixels).
   **Adopt. Horizon 1.**

## Interaction: one action, three surfaces

8. **Every command is a key, a button and a menu item, calling one
   method.** `shortcuts.ts` is one table; `?` shows it grouped (Move
   around · Select · Build · Explore). *digsite:* the sheet has tool keys,
   no help panel and no context menu. **Adopt: shortcut table, `?` panel,
   sheet context menu. Horizon 1.**
9. **The menu is built in sections:** the thing under the pointer · the view
   · undo/redo *named* ("Undo add connection") · export · delete last, in its
   own group. A right-click on something already selected keeps the
   selection and acts on all of it. **Adopt. Horizon 1; named undo in
   Horizon 2.**
10. **A mode that takes the pointer says so and offers a way out.**
    `syncModeBar`: "Drag across an image to draw a rectangle region",
    "Choose where the connection starts", with Cancel. *digsite:* only a
    pending edge is signalled. **Adopt. Horizon 1.**
11. **Arrows walk from image to image; Tab leaves the canvas.**
    `spatial.ts#neighbourInDirection`; Shift adds to the selection. The
    canvas is focusable, described for screen readers, and a polite live
    region announces the tool and the selection, never mid-gesture.
    *digsite:* Tab walks images in the Region tool. **Adopt arrows and the
    announcer; keep Tab for the loop only while drawing. Horizon 6.**
12. **The cursor warns before the click:** grab, grabbing, crosshair,
    copy, pointer over a target, resize over a grip. **Adopt. Horizon 1.**

## Exploration: explore what you pointed at

13. **Explore acts on the selection:** one image (one hop), several (all,
    none anchored), a connection (its two ends), or a relation (every image
    it joins, no anchor, no hops). *digsite:* the board explores a focused
    image only. **Adopt: explore a connection and a relation. Horizon 3.**
14. **Trace the path.** `tracePath`: the shortest chain from the nearest
    starting image, shown as a panel, one line per step
    (`A → resembles → B`). *digsite:* none. **Adopt as "How are A and B
    connected". Horizon 3.**
15. **Hop rings.** `force-layout.ts`: rings by distance, a clearance force
    that pushes pictures off lines, cooling so it settles, pins and expand.
    A rebuild after an edit moves nothing; only a changed question moves
    pictures. **Adopt for the board's graph view. Horizon 3.**
16. **A cap is said, not hidden** (150, `Neighborhood limit: 150`).
    *digsite:* "(capped)". **Keep.**

## Regions and properties

17. **Extract a region as its own image**, named `Region · Parent`, placed
    beside the parent without overlap, joined by `derived from`. The move a
    meme researcher makes with a template. **Adopt. Horizon 2.**
18. **Geometry as numbers,** validated in plain words ("Keep the rectangle
    inside the image…"). **Later.**
19. **Polygons.** **Skip:** rectangles only was decided for v1.
20. **Property rows remember a value across a format change** and report a
    problem on the row as it is typed; Save stays in view. **Adopt the
    first two. Horizon 1.**

## Output and trust

21. **A view as a note block** (`embed.ts`): an image and a depth, or a
    relation; read-only, never written back. *digsite equivalent:* a stable
    link to a view or a claim. **Horizon 5.**
22. **Export** an editable canvas or a still. **Horizon 5 report.**
23. **Verify the saved record, not the button** (`docs/workflows`).
    *digsite:* the claims walk does. **Keep as the definition of done.**

## Not carried over

The Obsidian file explorer sync, companion notes and atlas pages are
Obsidian-specific. Move mode with snapping belongs to image-graph's editable
whole-vault grid; digsite's board is a derived map and its sheets are
documents where dragging already moves pictures.
