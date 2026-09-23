---
scope: [server/src/boards/**, server/src/sheets/**, server/src/storage/quota.ts]
tags: [removal, quota, storage, sheets, boards]
priority: high
source: hand-written
checks:
  - forbid: 'DELETE FROM (sheets|boards)\b'
    in: server/src/**
    except: [server/src/boards/removal.ts, server/src/test/**, server/src/db/migrations/**]
    message: remove a sheet or a board only through boards/removal.ts
  - forbid: 'SET missing = true'
    in: server/src/**
    except: [server/src/boards/removal.ts, server/src/test/**, server/src/db/migrations/**]
    message: an image goes missing only through boards/removal.ts#removeImage
---

# server: what a removal takes with it is decided in `boards/removal.ts`

`removeImage`, `removeSheet` and `removeBoard` own the rows, the stored
objects and the group's quota. A route asks its access intent, calls one,
and answers. The private board's team stays in the route, because
removing it needs the request's session.

Until 2026-09-23 each cascade was written inside its route handler. The
sheet's rows were spelled twice, and `DELETE /boards/:id` never gave its
bytes back to `group_storage`: every deleted board kept filling its
group's quota for good. Only an HTTP test could reach any of it.

## What must stay true

- **A table that names a board or a sheet gets a line in `removal.ts`**,
  or an `ON DELETE CASCADE` in its migration. A missed table fails the
  `DELETE FROM boards` with a foreign-key error, or orphans rows.
- **The quota gets back exactly what was unlinked.** An original is one
  object per board per sha256, so it is paid back when the LAST image
  still on the board that stores it goes. A board pays back every
  distinct object of its non-missing images, inside the transaction that
  deletes the rows (`quota.ts#releaseFromGroup`): the board row is gone by
  commit, so `release(boardId, …)` cannot find the group afterwards.
- **An image is never deleted as a row.** It goes missing and keeps its
  slot (`ladder-slot-vs-rank.md`).

Verify with `cd server && bun test removal delete quota`.
