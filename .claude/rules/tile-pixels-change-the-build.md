---
scope: [server/src/boards/**, server/src/worker/**, server/src/meaning/**]
tags: [tiles, cache, ranks, invalidation, http]
priority: high
source: hand-written
checks:
  - forbid: 'SET stale = true'
    in: server/src/**
    except: [server/src/boards/change.ts, server/src/test/**, server/src/db/migrations/**]
    message: mark ranks stale only through boards/change.ts#boardChanged
  - forbid: "kind: 'page'"
    in: server/src/**
    except: [server/src/boards/change.ts, server/src/boards/invalidation.ts, server/src/test/**]
    message: publish a repainted page only through boards/change.ts#pagesRepainted
---

# server: anything that changes a tile's pixels makes a new order build

A tile URL carrying `?v=<token>` (roadmap item 7) is cached by the browser
for a year, `immutable`. The token is `ranks.ts#orderToken` of the order
build the tile was drawn from. So a pixel that changes without a new build
is kept wrong in every browser that saw it, and nothing on the server can
take it back.

## What must stay true

- **Every change to what a tile draws goes through `boards/change.ts`.**
  `pagesRepainted` right after a ladder page is written, `boardChanged`
  after everything else the change touches. Today's callers: an upload,
  a paint, a ladder job that fails for good (the pending placeholder
  goes), a property edit, an arrangement. The seam lint above fails the
  build on a stale mark or a page event anywhere else.
- **Publish the page event before the stale mark.** NOTIFY delivers in
  commit order. `invalidation.ts#catchUp`, which `rankOrder` runs on its
  first sight of a build, relies on that order. It is how a process that
  learns a build from the database has already dropped the pages that
  build replaced. Reverse the two and an API process can draw the new
  build from old resident pages.
- **A tile names the build it was drawn from, not the current one.** The
  composed cache and the resident coarse sorts store their version
  (`tiles-cache.ts`, `coarse-cache.ts`). The route compares `v` to the
  SERVED tile's token. A cache that lags the database then answers
  `no-store`, never `immutable`.
- **A tile with a pending cell is not final**, and is never `immutable`.
- **Every answer in ranks sets `X-Order-Version`** (`routes.ts#sayOrder`)
  from the one order it read, passed down as `given`. A new rank reader
  takes `given?: RankOrder`. Reading the order a second time can mix two
  builds in one answer, which is C3.

Verify with `cd server && bun test order-version tile-version invalidation`.
The barrier test in `invalidation.test.ts` fails without `catchUp`.
