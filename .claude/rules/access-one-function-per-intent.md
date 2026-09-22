---
scope: server/src/**
tags: [access, groups, better-auth, security]
priority: high
source: hand-written
checks:
  - forbid: '"(member|team|teamMember)"'
    in: server/src/**
    except: [server/src/access/, server/src/auth.ts, server/src/test/, server/src/db/migrations/]
    message: reads a membership table outside server/src/access/
  - forbid: '\.open\s*\|\|'
    in: server/src/**
    except: [server/src/access/, server/src/test/]
    message: writes the open-or-allowlist predicate outside access/
---

# server: every request asks one access function, and nothing else reads membership

`src/access/index.ts` holds one function per intent: `groupForViewing`,
`groupForInviting`, `boardForViewing`, `boardForUploading`,
`boardForCreatingSheet`, `boardForManagingAllowlist`, `boardForCreating`,
`boardsForListing`, `sheetForEditing`, `imageForViewing`. Each returns
the object or throws `AccessDenied(reason)`; a route turns that into
`403 {reason}`. The predicate
`member(user, group) AND (board.open OR member(user, allowlist))` is
written inside that module and nowhere else. Zulip's `access_stream_*`
pattern (`research/zulip/zerver/lib/streams.py`).

Measured 2026-09-21 on the groups prototype: a check costs 0.28 ms p95
warm, a socket join gate 2.9 ms. There is no performance reason to
bypass it, cache it, or fold it into a route's own query.

## What must stay true

- **No other file queries `member`, `team` or `teamMember`.** A new
  route that needs a new answer gets a new function here, named for the
  intent, and a row in the matrix test. A list shown on a page (members,
  allowlist) is read through `access/reads.ts`, after the route has
  passed its intent. `scripts/lint-seams.ts` fails the build on any
  other read.
- **An object the user may not see is `403`, never `404`.** Existence
  must not leak. Decide access first, then look for the object.
- **An owner not on a private board's allowlist is denied.** Ownership
  does not bypass the allowlist. This was chosen on purpose in the
  prototype (`../prototype/groups/CONTRACT.md`) and kept. Changing it is
  one line in `boardForViewing` and a changed cell in `access.test.ts`;
  it is not a special case elsewhere.
- **`boardsForListing` is one query.** A private board the user is not
  on is ABSENT from the list, never greyed. Do not list then filter with
  N calls to `boardForViewing`.
- **The socket gate is the same function.** `room.ts#join` calls
  `sheetForEditing`; there is no second predicate for sockets.
- **The plugin's roles are the outer line, not the gate.** `auth.ts`
  widens the `member` role so any member can create a team (a private
  board's allowlist); `boardForManagingAllowlist` (creator, or org
  owner/admin) is what actually decides who edits an allowlist, and it is
  the only caller of the team-member routes.

## What the plugin does, so nothing here defends against it twice

- Leaving or being removed from a group deletes the user's `teamMember`
  rows in the same transaction (`adapter.deleteMember` loops every team).
  The predicate never sees a stale allowlist.
- Adding a non-member to a team is refused
  (`USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION`).
- An expired invitation and a consumed one both return
  `400 INVITATION_NOT_FOUND`, byte-identical. Product copy must not
  promise to tell them apart from the accept response.
- `teams.defaultTeam` is OFF in `auth.ts`. With it on, every
  organization carries an invisible team named after itself. Do not
  count teams as a proxy for private boards.
- Better Auth POSTs need an `Origin` header; the cookie is
  `better-auth.session_token`; generated columns are camelCase and must
  be quoted in SQL.

Verify with `cd server && bun test access.test.ts`: five users × seven
intents, zero deviations, plus the per-user board lists; and
`bun run lint:seams` at the root.
