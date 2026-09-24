---
scope: [web/src/report/**, web/src/sheet/canvas/**, web/src/board/WebDiagram.tsx, web/src/board/web-layout.ts, web/src/components/Compare.tsx, web/src/components/compare-view.ts, web/src/components/Icon.tsx, web/src/sheet/routing.ts, web/src/sheet/labels.ts, web/src/sheet/connection-emphasis.ts, web/src/theme/palette.ts, shared/src/report/**]
tags: [report, viewer, seam]
priority: high
source: hand-written
checks:
  - forbid: "from '[./]*(lib/(api|auth|order-version)|sheet/(room|sync|tools))(\\.ts)?'|socket\\.io|better-auth"
    in: [web/src/report/viewer/**, web/src/sheet/canvas/**, web/src/board/WebDiagram.tsx, web/src/board/web-layout.ts, web/src/components/Compare.tsx, web/src/components/compare-view.ts, web/src/components/Icon.tsx, web/src/sheet/routing.ts, web/src/sheet/labels.ts, web/src/sheet/connection-emphasis.ts, web/src/theme/palette.ts]
    message: the report viewer's import tree reached a server client; a report file must run with no server
---

# report: the viewer runs with no server behind it

A report file (`web/src/report/file.ts`) carries the viewer bundle
(`web/vite.viewer.config.ts`, `src/report/viewer/main.tsx`) and the data
and pictures it reads. It is opened from a disk, a mail attachment or an
archive, years later. So nothing in the viewer's import tree may talk to
the app's server, sign in, or open a socket. The check above covers every
file in that tree as of 2026-09-23 (31 files; list them with an import
walk from `main.tsx`). A new import into the tree adds its file here.

## What must stay true

- **The document is complete without the viewer.** `shared/report/document.ts`
  draws everything a citation needs; the viewer only adds. Print shows the
  still (`.sheet-figure.is-live > img` comes back under `@media print`).
- **The viewer reads the data block, never the markup.** Pictures come from
  `svg.defs image[data-image-id]`; claims from `#digsite-report`. Changing
  the document's layout must not break the viewer.
- **One drawing, reused.** The live sheet is `sheet/canvas/Canvas.tsx` in
  `readOnly` mode (gesture mode `read`); the web is `board/WebDiagram.tsx`;
  Compare is `components/Compare.tsx`. Never a second copy of any of them
  for the report: a copy is how the report comes to disagree with the app.
- **The app's CSS lives in the viewer's shadow root.** The design tokens are
  custom properties on the document's `:root` and inherit into it. Do not
  move app CSS into the document; it would restyle the document.
- **The file is a snapshot of the viewer too.** A file made today carries
  today's bundle. `digsite-report/1` is what a future viewer must still
  read; bump `REPORT_FORMAT` when a field changes meaning.

Verify with `bun run lint:seams`, `cd web && bun run build:viewer` (it must
build with no warning about external imports), and walk claim 13 of
`bun run e2e:fresh src/sense-claims.ts`, which opens the downloaded file
with no server and uses Compare and Show.
