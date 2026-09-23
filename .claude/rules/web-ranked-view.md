---
scope: [web/src/pages/Board.tsx, web/src/board/**, web/src/lib/api.ts, web/src/lib/order-version.ts]
tags: [ranks, build-token, c3, board]
priority: high
source: hand-written
---

# web: every answer in ranks goes through the ranked view

A rank means an image only under one build of one sort. The board page
holds several answers in ranks at once — sections, find, the selection's
images, Explore's ranks, the annotated marks — and the map draws them
together, so they must all come from the build the tiles show (C3, and the
server's `tile-pixels-change-the-build.md`).

`board/ranked-view.ts#RankedView` is that rule, once. One view per
(board, sort). It delivers a reply only when the reply names the view's
build or names none, clears and re-asks every answer when a newer build
appears, drops a reply from any other build, and tells `onMove` listeners
(the tile and rank-to-image caches). Before 2026-09-23 this was six
effects on the board page, each keeping it with a `biome-ignore`.

## What must stay true

- **A new answer in ranks is a `useRanked(view, key, ask)`**, never an
  effect with its own fetch. An effect cannot know about a move unless
  someone remembers to thread it through, and nobody will.
- **`ask` returns the reply exactly as `lib/api.ts` gave it.** The build
  is recorded against that object (`api.ts#buildOf`, a WeakMap). Map or
  reshape it after delivery, in a `useMemo`, or the check never runs.
- **The key names the whole question.** Anything that should make the
  answer come again goes in it; an object that is replaced rather than
  changed (the vocabulary) goes in as `identity(obj)`.
- **A range selection sends `view.build`**, the build the swept ranks
  were drawn from.

Verify with `cd web && bun test ranked-view order-version`, then
`bun run e2e:fresh src/sense-claims.ts` (claim 15 moves the build).
