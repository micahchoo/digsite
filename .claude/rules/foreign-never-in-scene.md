---
scope: web/src/sheet/**
tags: [sheet, foreign, overlay, excalidraw]
priority: high
source: hand-written
checks:
  - require: 'export function isSyncable'
    in: web/src/sheet/sync.ts
    message: sync.ts must export isSyncable
  - forbid: '^(?!\s*//).*\bforeign\b'
    in: web/src/sheet/sync.ts
    message: 'isSyncable has a foreign clause: a foreign claim reached the scene; find that instead'
  - forbid: 'customData\s*:\s*\{[^}]*\bforeign\s*:'
    in: web/src/sheet/**
    message: builds an element whose customData carries a foreign marker
  - forbid: '\bid\s*:\s*[''"`]foreign-'
    in: web/src/sheet/**
    message: uses the prototype's foreign-<sheet>-<id> element id scheme
  - forbid: 'updateScene[^\n]*foreign|foreign[^\n]*updateScene'
    in: web/src/sheet/**
    except: web/src/sheet/overlay/
    message: passes foreign data to updateScene
---

# sheet: a foreign claim is never an Excalidraw element

The Excalidraw scene of a sheet holds only what that sheet owns: its
images, its regions, its edges. A claim from another sheet is drawn by
`overlay/` on an `<svg>` above the canvas, from rows the client polls,
with our own pointer handling. It has no element id, no `customData`,
no place in undo, no place in sync, and no place in a snapshot.

Decided 2026-09-21 after the sheet prototype, where foreign claims WERE
locked elements (`locked: true`, `strokeStyle: 'dashed'`, filtered out
of sync and persistence by a `customData.foreign` check). That held
under test — zero leaks in 62 scenes — and still produced the one
failure of the run: a pointer drag on a locked foreign rectangle fell
through Excalidraw's hit test to the unlocked IMAGE beneath and moved
it, and `copyForeign` then built its copy from the foreign element's
cached position and clamped it into the wrong corner.

The overlay removes the class, not the instance. There is no
`isSyncable` filter for foreign, no `CaptureUpdateAction.NEVER` for
foreign, no reconciliation special case, and nothing for the server's
`foreignInScene` counter to find. That counter stays in `/stats` so a
regression is measured, not argued.

## What must stay true

- **`sync.ts#isSyncable` has no foreign clause.** If you find yourself
  adding one, something put a foreign claim in the scene. Find that
  instead.
- **The fractions are the fact; pixels are derived at render.** Every
  foreign shape's rect is `fromFraction(row, imageRectNow)` computed
  from the image element's CURRENT rect on every render, never cached
  from an earlier poll. `copyForeign` copies the ROW's fractions and
  places against the image now. Anything that acts on polled data
  rebases against local state at write time.
- **The overlay owns its pointer events.** A click on a foreign shape
  sets our selection and stops propagation. A drag does nothing. The
  pointer never reaches the canvas beneath, so nothing can fall through
  to the image.
- **A foreign edge is drawn between CURRENT rects** — this sheet's image
  or own region, or the foreign region if this sheet also sees it — and
  is a dangling stub, not an error, when an end is missing.
- **Copy carries fractions, label and properties, and nothing about its
  origin.** The copy is an ordinary own region from the moment it exists.

This is image-graph's rule for Image Annotation's regions, moved to the
web: read, shown, selectable, never written
(`../../.claude/rules/image-graph-foreign-regions.md` in the notebook,
`src/annotations.ts#readAnnotationIndex` in the plugin).

Verify with the e2e scenarios 6–8: no element with `foreign` in any
scene, snapshot or `/stats`; a copy made right after moving the image
lands on the moved image; a real pointer drag across a foreign shape
moves nothing.
