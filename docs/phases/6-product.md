# Phase 6 — the product, designed

Everything works; now it has to feel like one place. This phase is a
product-design pass, not a feature list. Words: `../../CONTEXT.md`.

## The three metaphors, and what each one decides

The owner named them in order of weight. Each is a source of decisions,
not a costume.

1. **Discord.** The shell. A left rail of groups as round icons; a
   second column of the group's boards as `#channels` with private
   boards marked by a lock, sheets nested under their board like
   threads; the main pane is the board or the sheet; a right column of
   who is here. Unread/activity dots on boards and sheets. Invites as
   links you paste. Roles and allowlists live in "board settings" and
   "group settings" modals, the way Discord keeps channel permissions
   out of the way. Keyboard: Ctrl+K quick switcher across groups,
   boards and sheets.
2. **The image-graph plugin's feel.** The canvases. Dense, calm, tool-
   like: pictures are the content and chrome recedes. Dashed foreign
   regions, relation colours, a hover card, an inspector that is a
   property table, a thin status bar with counts, drag to pan, wheel to
   zoom at the pointer, the Actions menu and right-click menus with the
   same actions as keys and buttons (one action, three surfaces). Read
   the plugin's `view.ts`, `scene.ts`, `styles.css` and the notebook
   rules under `.claude/rules/image-graph-*.md` for the specifics.
3. **2000s GeoCities.** The personality, applied with restraint to the
   surfaces around the tools, never inside them: a group can have a
   homepage (the group page) with a banner, a tiled background, a
   visitor counter (images, sheets, members), a guestbook-style
   activity feed, "under construction" empty states, 88×31 badge-style
   chips for boards, webring-style prev/next between sheets on a board,
   pixel/bitmap accents, system fonts like Verdana/Tahoma for chrome
   text, bevelled buttons. Each group may pick a theme from a small
   set. Inside the map and the sheet, it steps back to image-graph's
   calm; the joke must never cost a click.

## Also in this phase: what the brainstorm specified and the build missed

- **Sheets are threads** (brainstorm: "a sheet is a Discord THREAD
  under a board"). The data model is built; the thread experience is
  not. In the channel column, a board's sheets nest under it with a
  thread glyph, most recent activity first, the ones with activity
  since you last looked in bold. "Start a sheet" sits where Discord's
  "create thread" does: on the board's selection bar and on an image's
  context menu, naming it in place. A sheet header shows its board as
  the parent (`# Field › First pass`) with a way back. A board lists
  its sheets as a thread browser (name, image count, who has been in
  it, last activity, a strip of its first images as a preview). Old
  sheets can be archived: hidden from the column, kept, searchable,
  reopened by anyone who can see the board. Last-seen per user per
  sheet is stored server-side (`sheet_reads(user_id, sheet_id,
  seen_at)`) so unread survives devices.

- **Find and filter on the board**: a search box (name, property
  values) and property filters (`year 1980..1990`, `site = x`) that dim
  non-matching cells on the map as an overlay and count matches; "select
  all matches" (capped at `SHEET_LIMIT` for a sheet). Server:
  `GET /boards/:id/find?q=&filter=` returning ranks under the current
  sort, via the same `board_ranks` join; filters never rebuild ranks.
- **Typed properties complete**: `date` and `list` join text, number,
  boolean in `PropertyType`, the inspector, the sort keys and
  `parseSortId`; a GIN or expression index on the property keys a board
  sorts or filters by, created when a sort or filter on that key is
  first built.
- **The board is the union of claims**: an image's detail panel lists
  every claim on it grouped by sheet (regions drawn on its thumbnail,
  edges as "→ image name, relation") with links to each sheet; the map
  marks images that carry claims with a small corner glyph (overlay).
- **Presence on the board by image**: viewers' hovered and selected
  images shown to others as coloured cell outlines with a name.
- **Copy a foreign claim, choosing what travels**: the copy action
  opens a small chooser — geometry always, label, properties (per key),
  and for an edge, its connections.
- **Relation filter in the sheet**: a relation list in the side panel;
  choosing one dims every other connection (image-graph's `filter`
  dims, never removes).
- **Board default sort** control for whoever manages the board.
- **Error and empty states**: 404, 403 ("you're not on this board's
  list — ask <creator>"), 500 with request id, offline/reconnecting on
  the sheet, and empty group/board/sheet states.

## Process

1. Audit (`docs/ux/audit.md`): walk every page as each fixture user,
   screenshot, and list every friction against the three metaphors and
   the heuristics in the notebook's `better-*` skills.
2. Design (`docs/ux/design.md`): the shell, the tokens (colour, type,
   spacing, the GeoCities theme set), the component inventory, each
   page as a wireframe, and the decisions with their metaphor.
3. Build in slices, each with a smoke and screenshots: shell and
   navigation; board page; sheet chrome; group homepage and themes;
   the missed features above; error and empty states.
