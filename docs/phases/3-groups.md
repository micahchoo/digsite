# Phase 3 — groups people can live in

The skeleton has the model and the gate. This phase gives people the
flows. Words: `../../CONTEXT.md`. Rule:
`../../.claude/rules/access-one-function-per-intent.md` — every new
route below names the one access function it calls, and the matrix
test grows a column for each new intent.

Done when `e2e/src/groups-life.ts` walks a group from creation through
invite, private board, allowlist change, a member leaving, a board
deleted with claims on it, and a sheet deleted, and every step's access
outcome and side effect is asserted.

## 1. Invitation links (`server/src/groups/`, `web/src/pages/`)

`POST /groups/:id/invite {email?}` returns `{invitationId, url}` where
`url` is `WEB_ORIGIN/join/<invitationId>`. `/join/:id` shows the group
name and inviter (`GET /invitations/:id` — public, returns only name,
inviter name and whether it is still open, or 404), and on accept
signs the user in or up first. An expired or used invitation shows one
message for both cases; the plugin cannot tell them apart. Pending
invitations are listed on the group page for owners and admins with
revoke (`DELETE /invitations/:id` → `groupForInviting`).

## 2. Roles and members (`web/src/pages/Group.tsx`)

Members list with role; owner and admins can change a member's role
(`PATCH /groups/:id/members/:userId {role}` → new intent
`groupForManagingMembers`: owner or admin, and only an owner may make
or unmake an owner) and remove a member. Leaving is on the group page.
An owner cannot leave while sole owner (`400` with reason).

## 3. Allowlists (`web/src/pages/Board.tsx`)

On a private board the user manages: the allowlist as a list of
members with add (from group members not yet on it) and remove. The
creator is on it from creation and can remove themself only if another
allowlisted user manages it, else `400`.

## 4. Rename and delete, with claims accounted for

- `PATCH /boards/:id {name}`, `DELETE /boards/:id` → new intent
  `boardForDeleting`: creator or owner/admin. Deleting a board deletes
  its sheets, their snapshots and rows, its images' rows, and its
  files under `DATA_DIR`, in that order, in one transaction for the
  rows and a best-effort sweep for the files. The confirmation names
  the counts (`GET /boards/:id/footprint` → `{images, sheets, regions,
  edges}`).
- `DELETE /sheets/:id` → `sheetForDeleting`: creator or the board's
  manager. Deletes the snapshot and the rows; claims that other sheets
  saw as foreign simply vanish from their next poll, and their own
  copies stay. The confirmation says how many foreign views it will
  affect (count of other sheets holding an image with a claim from
  this sheet).
- Removing an image from a board (`DELETE /images/:id` → new intent
  `imageForDeleting`, same rule as `boardForDeleting`) sets
  `missing = true` and removes the
  original; the row, the slot and every claim on it stay. Sheets show
  the image as a missing placeholder. There is no hard delete of an
  image in this phase.

## 5. The group page as a home

Boards with image and sheet counts and last activity; recent sheets
across boards the user can see; a "create board" that explains open vs
private in one sentence each.

## Tests

- `access.test.ts` gains columns for `groupForManagingMembers`,
  `boardForDeleting`, `sheetForDeleting`, `imageForDeleting` for all
  five users; still zero deviations.
- `delete.test.ts`: deleting a board with two sheets and cross-sheet
  claims leaves no rows referencing it and no files; deleting a sheet
  leaves the other sheet's own copies intact and its foreign poll
  empty of that sheet.
- `e2e/src/groups-life.ts` as above.
