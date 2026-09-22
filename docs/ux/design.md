# digsite — UX design

Reads against `../../CONTEXT.md` (the words), `../phases/6-product.md` (the
three metaphors, Selection, the missed features) and `audit.md` (the current
product's friction). Every decision below is traceable to one of those three.
Mockups: `design/*.png`, sources in `design/src/`.

## 1. Principles

1. **Chrome is Discord's, canvases are image-graph's, personality is the
   group homepage's** — the rail, the channel column and the top bar carry
   navigation weight everywhere; the board and the sheet stay dense and
   quiet; GeoCities texture never crosses into the map or the scene, so the
   joke never costs a click.
2. **One action, three surfaces** — every command an engineer adds gets a
   key, a button or menu item, and a right-click/Actions-menu entry, all
   three calling the same function, the way `image-graph`'s `view.ts#menu`
   does; a feature with only a keyboard path or only a menu path is
   half-built.
3. **The shell never disappears** — routes render inside the persistent
   rail and channel column, not as bare full-page navigations, so a 403, a
   404, a loading board and a working one are all told apart inside the same
   frame instead of a blank page each guessing what happened.
4. **Selection is a durable object, not a view artifact** — a set of image
   ids, owned by the viewer, stored server-side; it survives sort changes,
   zoom, panning and reload, because it is how a group's pile becomes a
   sheet, and a verb that silently loses its object is a defect, not a
   feature gap.
5. **A claim's owner is always legible at a glance** — a sheet's own
   regions and edges draw solid in the claim-own/claim-edge strokes; every
   other sheet's claims on the same image draw dashed and muted on the
   overlay, never inside the scene, so nobody mistakes another sheet's
   argument for their own.

## 2. Tokens

All colour tokens are CSS custom properties on `:root` (light) and
`:root[data-theme="dark"]` / `@media (prefers-color-scheme: dark)`
(dark). Contrast ratios below are computed (WCAG relative-luminance
formula), not estimated.

### 2.1 Colour — light

```css
:root {
  /* surfaces */
  --surface-app:       #F5F6F8;  /* rail, channel column, top bar */
  --surface-raised:     #FFFFFF; /* panels, cards, modals, inspector */
  --surface-sunken:     #ECEEF1; /* inputs, wells */
  --surface-canvas:     #FAFAFB; /* board map, sheet scene */
  --surface-overlay:    rgba(255,255,255,0.94); /* status pills, hover card */

  /* text */
  --text-primary:   #1A1D21;   /* 15.64:1 on --surface-app */
  --text-secondary: #5B6169;   /* 5.78:1 on --surface-app */
  --text-faint:     #6B7179;   /* 4.56:1 on --surface-app — smallest size this may carry text at */

  /* lines */
  --line:        #DFE2E6;
  --line-strong: #C4C9D0;

  /* accent + danger */
  --accent:          #4F5DFF;
  --accent-hover:    #4048D6;
  --text-on-accent:  #FFFFFF;  /* 4.84:1 on --accent */
  --danger:          #C9333B;  /* 4.83:1 on --surface-app */
  --danger-hover:    #A82A31;

  /* claims, on --surface-canvas */
  --claim-own:     #1F8F63;  /* solid 2px region stroke, 3.90:1 */
  --claim-edge:    #B96A1B;  /* solid 2px edge/connection stroke, 3.92:1 */
  --claim-foreign: #767C85;  /* dashed 1.5px, 70% opacity, 4.03:1 */

  --focus-ring: #4F5DFF;
}
```

### 2.2 Colour — dark

```css
:root[data-theme="dark"] {
  --surface-app:     #1E2024;
  --surface-raised:  #26292E;
  --surface-sunken:  #17191C;
  --surface-canvas:  #121316;  /* matches image-graph's near-black stage */
  --surface-overlay: rgba(38,41,46,0.94);

  --text-primary:   #EDEEF0;  /* 14.05:1 */
  --text-secondary: #A8AEB6;  /* 7.30:1 */
  --text-faint:     #7D838B;  /* 4.27:1 */

  --line:        #34383E;
  --line-strong: #454A52;

  --accent:         #7C86FF;
  --accent-hover:   #939CFF;
  --text-on-accent: #12131A;  /* 5.92:1 on --accent */
  --danger:         #FF6B6F;  /* 5.89:1 */
  --danger-hover:   #FF8286;

  --claim-own:     #2AA876;  /* 6.16:1 on --surface-canvas */
  --claim-edge:    #E08A2E;  /* 6.94:1 */
  --claim-foreign: #9AA0AA;  /* dashed 1.5px, 70% opacity, 7.06:1 */

  --focus-ring: #939CFF;
}
```

Same mechanism as `prefers-color-scheme` fallback wrapped in
`:root:not([data-theme="light"])`, per the artifact/app convention — pick
one switching mechanism (an explicit `data-theme` attribute set by a
per-user preference, falling back to the media query) and use it
everywhere; never mix a class toggle and the media query for different
tokens.

### 2.3 Presence palette (8)

Used for cursor outlines, selection-in-progress outlines and presence
chips. Rendered as a small filled dot (never as a text background — see
§6 on why chip text stays `--text-primary`, not white-on-colour). Every
value clears 3:1 (WCAG 1.4.11, non-text/UI-component contrast) against
both `--surface-raised` variants:

| # | Name | Hex | vs light raised | vs dark raised |
| --- | --- | --- | --- | --- |
| 1 | red | `#E5484D` | 3.91:1 | 3.73:1 |
| 2 | rust | `#D2560C` | 4.14:1 | 3.53:1 |
| 3 | gold | `#B8860B` | 3.25:1 | 4.48:1 |
| 4 | green | `#46A758` | 3.03:1 | 4.81:1 |
| 5 | teal | `#12A594` | 3.07:1 | 4.75:1 |
| 6 | blue | `#3B82F6` | 3.68:1 | 3.97:1 |
| 7 | violet | `#8B5CF6` | 4.23:1 | 3.45:1 |
| 8 | pink | `#E93D82` | 3.85:1 | 3.79:1 |

A viewer is assigned the next unused index on join, reused (LRU) past 8
concurrent viewers. On the canvas a presence outline gets a 1px halo in
`--surface-canvas` behind the colour so it reads on both themes without
per-theme presence variants.

### 2.4 Type

```css
--font-ui: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
           Helvetica, Arial, sans-serif;
--font-geo: Verdana, Tahoma, sans-serif;  /* personality surfaces ONLY — see §2.6 */
--font-mono: ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas,
             monospace;  /* status pills, ids, counts */
```

`--font-geo` is scoped to the group homepage, its badges, its guestbook
and its banner — never the shell chrome, the board or the sheet. A
component under `.geo-surface` may use it; nothing else may reach for it.

Type scale (px, named by use, not by size — `better-typography`):

| Token | Size | Line-height | Weight | Use |
| --- | --- | --- | --- | --- |
| `--text-2xs` | 11 | 1.4 | 400 | timestamps, counts |
| `--text-xs` | 12 | 1.4 | 400 | captions, badges |
| `--text-sm` | 13 | 1.45 | 400 | dense UI (channel list, inspector fields) |
| `--text-base` | 14 | 1.5 | 400 | default UI text, buttons |
| `--text-md` | 15 | 1.5 | 500 | list item titles, card headers |
| `--text-lg` | 17 | 1.4 | 600 | panel headings ("Properties", "Connection") |
| `--text-xl` | 20 | 1.3 | 600 | page headings (board name, group name) |
| `--text-2xl` | 24 | 1.2 | 700 | homepage banner title |
| `--text-3xl` | 32 | 1.15 | 700 | sign-in / join headline |

Inputs are `--text-base` (14px) on desktop; every `<input>` bumps to 16px
via `font-size: 16px` at `max-width: 767px` to stop iOS Safari's
auto-zoom (`better-typography`). All UI text is `--font-ui`; `--text-2xs`
and status-bar counts use `--font-mono` with `font-variant-numeric:
tabular-nums`.

### 2.5 Spacing, radii, shadows, focus

```css
--space-1: 4px;  --space-2: 8px;  --space-3: 12px; --space-4: 16px;
--space-5: 20px; --space-6: 24px; --space-8: 32px; --space-10: 48px;
--space-12: 64px;

--radius-s: 4px;    /* inputs, chips, small buttons */
--radius-m: 8px;    /* cards, panels, toolbar */
--radius-l: 12px;   /* modals, the tray */
--radius-full: 999px; /* avatars, badges, the group rail icons */

--shadow-s: 0 1px 2px rgba(0,0,0,.08), 0 1px 1px rgba(0,0,0,.04);   /* hover card, footer pills */
--shadow-m: 0 4px 12px rgba(0,0,0,.12), 0 1px 2px rgba(0,0,0,.06);  /* inspector, tray, dropdowns */
--shadow-l: 0 12px 32px rgba(0,0,0,.18), 0 2px 6px rgba(0,0,0,.08); /* modals, quick switcher */
```

Concentric radius: a panel at `--radius-m` (8px) with `--space-3` (12px)
padding gives its inner buttons `--radius-s` (4px) = 8 − (12 − 8); do not
give an inner control the same radius as its container.

Focus ring, every interactive element, `:focus-visible` only: `outline:
2px solid var(--focus-ring); outline-offset: 2px;`. Never `outline:
none` without this in place.

### 2.6 GeoCities theme set (4)

A group picks one in group settings. Scoped to `.geo-surface` (the
homepage, its banner, its badges, its guestbook feed) — never the rail,
channel column, board or sheet. Each theme supplies five values; the
component structure (banner, badge, guestbook, visitor-counter strip) is
shared, only these swap:

| Theme | Background tile | Heading | Link | Banner |
| --- | --- | --- | --- | --- |
| **Dig Site** (default) | `repeating-radial-gradient(circle at 8px 8px, #D9C79E 0 2px, transparent 2px 16px) #E8DCC0` — sand with a dotted screen-print texture | `#7A2E1D` (6.90:1) | `#145C52` (5.75:1) | linear-gradient `#D2B48C → #A9825A`, 3px inset bevel border, text shadow `1px 1px 0 #3A2410` |
| **Deep Sea** | `repeating-radial-gradient(circle at 20px 20px, #13315C 0 3px, transparent 3px 24px) #0B2545` — navy with faint bubbles | `#8ED1FC` (9.29:1) | `#FFD166` (10.67:1) | linear-gradient `#0B2545 → #123A61`, 3px inset bevel, white text (11.64:1) |
| **Hot Pink Lab** | `repeating-conic-gradient(#1A0014 0 25%, #33002B 0 50%) 0 0/24px 24px` — 2-tone checker | `#FFFFFF` (19.92:1) | `#FFE066` (15.28:1) | linear-gradient `#FF2E9F → #B300E0`, 3px inset bevel, white text (5.26:1) |
| **Terminal** | `repeating-linear-gradient(180deg, #0A0F0A 0 2px, #05070A 2px 4px)` — scanlines | `#39FF14` (14.87:1) | `#E6E6E6` (16.16:1) | flat `#0A0F0A`, 1px solid `#39FF14` border, lime text with `text-shadow: 0 0 6px #39FF14` (14.27:1) |

Every heading/link ratio above is measured against that theme's flat
background colour (the tile's base, not its highlight dot), every banner
ratio against the banner's darker gradient stop — the worst-case pixel a
reader's eye lands on.

Bevel recipe (all four): `border: 2px solid; border-color: <light 40%>
<dark 40%> <dark 40%> <light 40%>` (light top/left, dark bottom/right —
the classic outset button look), `box-shadow: inset 0 0 0 1px rgba(0,0,0,.15)`.

## 3. The shell

### 3.1 ≥1280px — four columns, all visible

```
┌────┬──────────────┬──────────────────────────────────────┬──────────┐
│ 72 │ 240          │ flex                                  │ 280      │
│ ra │ channel      │ main pane                             │ right    │
│ il │ column       │ (board / sheet / group page)          │ column   │
│    │              │                                        │          │
│ ○  │ Lab      ⚙   │ ┌────────────────────────────────────┐│ Who's    │
│ ○  │ ────────     │ │ # Field › First pass          🔍 ⋯ ││ here     │
│ ○  │ # Field    ● │ │ ──────────────────────────────────  ││ ● Micah  │
│ ●  │  ↳ First pass│ │                                      ││ ● Alex   │
│ +  │  ↳ Faces     │ │         (map or sheet canvas,        ││          │
│    │ # Finds  🔒  │ │          full-bleed)                 ││ ─────    │
│    │ # Synthetic  │ │                                      ││ Tray ▾   │
│    │              │ │                                      ││ 12/150   │
│    │              │ └────────────────────────────────────┘│          │
└────┴──────────────┴──────────────────────────────────────┴──────────┘
```

- **Rail**, 72px, `--surface-app`, fixed for the whole session. Group
  icons 40×40px circles (`--radius-full`), 16px vertical gap, current
  group gets a 3px accent-coloured left bar (Discord's "pill") and a
  filled ring; an unread group gets a filled white dot bottom-right of
  its icon (never a number — groups don't get badge counts, boards and
  sheets do). Bottom: `+` circle, "Create or join a group".
- **Channel column**, 240px fixed, `--surface-app`, 1px `--line` trailing
  border. Header: group name (`--text-md`, 600), a gear icon button
  (opens group settings) trailing. Below: the board list. A board row is
  `# name`, `--text-base`; a private board gets a lock glyph (12px)
  before the name; a board with unseen activity is 600 weight with an
  accent dot trailing. A board's sheets nest directly under it, indented
  `--space-4` (16px), each row prefixed with a thread glyph (small
  branching-line icon, not a `#`), sheet name at `--text-sm`, unread
  (activity since last seen) in 600 weight, an accent dot trailing when
  unread. "Start a sheet" is the last row under a board's sheets,
  `--text-faint`, a `+` prefix, always present, never conditional on
  count.
- **Top bar**, 48px tall, inside the main pane, `--surface-app`, 1px
  `--line` bottom border. Leading: breadcrumb — `# Field › First pass`
  on a sheet, `# Field` on a board, group name on the homepage — each
  segment a link to that level, current segment `--text-primary` 600,
  ancestors `--text-secondary`. Trailing: a search icon button (opens
  find/filter on a board, nothing on a sheet), then a `⋯` overflow
  button for page-specific actions (rename, archive, delete, settings)
  that don't fit as icons. The zoom control and the inspector/tray
  toggle are NOT here — they float over the canvas (§4.5, §4.7), per
  image-graph's own rule that a mode must never resize the canvas.
- **Right column**, 280px fixed, `--surface-raised`, 1px `--line` leading
  border. Content depends on the main pane (§3.4).

### 3.2 768–1279px — right column collapses to an overlay

Rail and channel column stay exactly as above (there is room). The right
column disappears from the static layout; a toggle button appears in the
top bar (`Who's here` on a board, `Properties` on a sheet, with a count
badge — selection count or presence count). Pressing it slides a 320px
panel in from the trailing edge, `--shadow-l`, over the main pane (not
pushing it), with a scrim (`rgba(0,0,0,.24)`) behind it on the canvas
area only — not over the channel column, so the group/board context
stays visible while the panel is open. `Escape` or a click on the scrim
closes it; focus returns to the toggle button.

### 3.3 <768px — rail + channel column become a drawer

```
┌──────────────────────────────────┐
│ ☰  # Field › First pass    🔍 ⋯  │  ← top bar, 44px
├──────────────────────────────────┤
│                                    │
│      (canvas, full width)         │
│                                    │
│                                    │
│                          ┌──────┐  │
│                          │ 👥 3 │  │  ← floating button, opens
│                          └──────┘  │    right-column content full-screen
└──────────────────────────────────┘
```

The hamburger (☰, leading) opens the rail+channel column together as one
full-height drawer sliding from the leading edge, 280px wide (rail icons
run as a horizontal strip across the top of the drawer, 56px tall, then
the channel list below it) — the two merge into one drawer rather than
stacking two, because at this width a user picks a group and a board in
one motion, not two separate reveals. A floating round button
(bottom-right, `--shadow-m`, 48px) replaces the top-bar toggle from
§3.2 and opens the right-column content as a full-screen sheet (slides
up from the bottom, a drag-handle and `×` to dismiss). The zoom control
and selection tray keep their own bottom placement (§4.5, §4.7) but
shrink to touch sizing (34px min hit height per image-graph's own
`@media(max-width:600px)` rule) and the tray's per-thumbnail width drops
so the whole row still fits without horizontal scroll for 4-6 visible
thumbnails, with the rest reachable by a horizontal drag.

### 3.4 Right column content, by page

| Page | Right column |
| --- | --- |
| Group homepage | (hidden — the homepage has no right column; content is centred, full-bleed banner) |
| Board | "Who's here" (presence list) above a divider, then the selection tray's expanded form when the tray is pinned open (§4.5) — otherwise the tray lives at the canvas bottom and this column shows only presence, collapse to the toggle button below 1280px |
| Sheet | The inspector (§4.6) — property table for whatever is selected. Below it, when nothing else needs the space: the relation filter and the dangling-claims list (§4.6). |
| Group/board settings | (modal, no shell change) |

### 3.5 Quick switcher

`Ctrl+K` / `⌘K` anywhere inside the shell opens a centred modal, 560px
wide, `--shadow-l`, `--radius-l`. A single search input (autofocus,
placeholder "Jump to a group, board or sheet…"), fuzzy-matched against
every group/board/sheet the viewer can see (already loaded from the
group/board list — no new endpoint). Results grouped by type with a
small leading glyph (group icon / `#` / thread glyph), 8 max per group,
arrow keys move the highlight, `Enter` navigates, `Escape` closes. A
private board the viewer isn't on the allowlist for is absent, not
greyed — same rule as `boardsForListing`.

## 4. Pages

Every wireframe below is the ≥1280px layout; the shell frame (rail,
channel column, top bar) is abbreviated to `[shell]` where it doesn't
change page to page.

### 4.1 Sign in — `/`

```
┌──────────────────────────────────────────────────────────┐
│                                                              │
│                        digsite                              │
│         Arrange and connect your group's images.            │
│                                                              │
│              [ Sign in ]  [ Sign up ]                       │
│                                                              │
│              Email     [______________]                     │
│              Password  [______________]                     │
│                                                              │
│                    [ Sign in → ]                             │
│                                                              │
└──────────────────────────────────────────────────────────┘
```

No shell — this is the one page it doesn't exist yet for. Headline
`--text-3xl`, one sentence under it (`--text-md`, `--text-secondary`).
Mode toggle is a two-segment control (`--radius-s`, `--line` border); the
active segment gets `--surface-raised` background and `--text-primary`
600 weight, the inactive one `--text-secondary` on transparent — two
channels of difference (fill + weight), not `disabled` styling alone
(audit finding, minor). Primary button is full-width of the form,
`--accent` fill.

### 4.2 Join — `/join/:id`

Valid invite, signed out:

```
┌──────────────────────────────────────────────────────────┐
│ digsite                                          [ Sign in ]│
├──────────────────────────────────────────────────────────┤
│                                                              │
│                  Join a group                               │
│                                                              │
│     ┌────────────────────────────────────────┐             │
│     │  Lab                                     │             │
│     │  Invited by owner@example.test            │             │
│     └────────────────────────────────────────┘             │
│                                                              │
│              [ Sign in ]  [ Sign up ]                       │
│              (same form as §4.1)                             │
│                                                              │
└──────────────────────────────────────────────────────────┘
```

Closed or expired invite:

```
┌──────────────────────────────────────────────────────────┐
│ digsite                                          [ Sign in ]│
├──────────────────────────────────────────────────────────┤
│                                                              │
│              This invitation is no longer open.             │
│              Ask whoever invited you for a new link.         │
│                                                              │
│                      [ Sign in ]                             │
│                                                              │
└──────────────────────────────────────────────────────────┘
```

Both states keep a minimal top bar — wordmark, leading; a "Sign in" link,
trailing — so the page is never a dead end (audit: major finding, no
chrome, no way back). This bar is the one piece of shell present before
authentication.

### 4.3 Group homepage — `/g/:id`

Full `.geo-surface`. See `design/homepage-dig-site.png`,
`homepage-deep-sea.png`, `homepage-hot-pink.png`, `homepage-terminal.png`
for all four themes rendered.

```
[shell: rail + channel column, no right column]
┌──────────────────────────────────────────────────────────┐
│ ░░░░░░░░░░░░░░░░░░ tiled background ░░░░░░░░░░░░░░░░░░░░░ │
│ ┌──────────────────────────────────────────────────────┐ │
│ │  ╔══════════════════════════════════════════════╗    │ │
│ │  ║   L A B                                        ║    │ │  ← banner, bevelled
│ │  ║   a group of four, digging since 2024           ║    │ │
│ │  ╚══════════════════════════════════════════════╝    │ │
│ │                                                          │ │
│ │  [ 1,204 images ]  [ 12 sheets ]  [ 4 members ]         │ │  ← visitor-counter strip
│ │  (odometer-style digit chips, monospace, bevelled)       │ │
│ │                                                          │ │
│ │  Boards                                                  │ │
│ │  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐          │ │
│ │  │ Field  │ │ Finds🔒│ │Synthetic│ │  + New  │          │ │  ← 88×31 badge chips
│ │  │ 118 img│ │ 0 img  │ │ 1,000,000│ │  board  │          │ │
│ │  └────────┘ └────────┘ └────────┘ └────────┘          │ │
│ │                                                          │ │
│ │  Guestbook                                    [ Sign ]  │ │
│ │  ──────────────────────────────────────────────────    │ │
│ │  ● Alex started First pass on Field · 2h ago            │ │
│ │  ● Micah uploaded 40 images to Field · yesterday         │ │
│ │  ● Sam joined the group · 3 days ago                     │ │
│ │                                                          │ │
│ │                    under construction 🚧                 │ │  ← only if 0 boards
│ └──────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

- **Banner**: theme's gradient + bevel, `--text-2xl` group name (the
  theme's heading colour), an editable one-line tagline under it
  (`--text-md`), all `--font-geo`.
  256px tall on desktop, 160px below 768px.
- **Visitor-counter strip**: three stat chips, `--font-mono` digits,
  bevelled inset like a hit-counter GIF, reading real values from
  `GET /groups/:id/boards` + `/members` (no new endpoint — audit's
  cheapest win). Order: images, sheets, members — matches the CONTEXT.md
  ordering of what a group holds.
- **Board badges**: 88×31px (the classic web-ring badge size), one per
  board, sorted by `lastActivity` descending (audit finding: stop mixing
  real content with test boards — sort fixes it without hiding anything).
  Board name `--text-xs` 600, image count `--text-2xs`, lock glyph for
  private, `--font-geo`. Clicking opens the board. A "+ New board" tile
  in the same badge shape, dashed border, ends the row.
  A group with zero boards shows the "under construction" block instead
  of an empty badge row (§6 has the exact copy) — GeoCities' running gag,
  used honestly: there is in fact nothing built yet.
- **Guestbook**: an activity feed, newest first, capped at 20, "Load
  more" beneath — sheet created, images uploaded (batched: "Micah
  uploaded 40 images", not 40 rows), member joined, board created. Each
  row a presence-palette dot (the actor's colour) + one sentence +
  relative timestamp. A `Sign` button opens a plain-text comment box
  (member-authored, moderatable by owner/admin — reuses the group's
  existing role check, no new access function beyond
  `groupForViewing`/a new `groupForCommenting` intent alongside it).
- Below 768px the badge row becomes a horizontal scroller (peek 16px of
  the next badge, per `better-layout`'s "hint at hidden content"); the
  banner drops its tagline line if it would wrap past two lines at
  `--text-2xl`.

### 4.4 Group settings (modal)

```
┌──────────────────────────────────────────┐
│ Group settings                        ×  │
├──────────────────────────────────────────┤
│  Name        [ Lab                    ]  │
│  Theme       ( ) Dig Site  ( ) Deep Sea  │
│              ( ) Hot Pink  ( ) Terminal  │
│              [ preview swatch strip ]     │
│                                            │
│  Members                                  │
│  ┌──────────────────────────────────┐    │
│  │ owner@…    Owner        [Remove]  │    │
│  │ member@…   Member ▾     [Remove]  │    │
│  └──────────────────────────────────┘    │
│                                            │
│  Invite      [ email (optional)    ] [Send]│
│  or share a link anyone can use: [Copy]   │
│                                            │
│  ──────────────────────────────────────   │
│  Danger zone                              │
│  [ Delete this group ]  (owner only)      │
└──────────────────────────────────────────┘
```

Role change and member removal both open the same inline confirm chip
used on board/sheet delete (audit finding — consistency): "Change Alex to
admin?" / "Remove Sam from Lab?" with `Confirm` / `Cancel`, no separate
modal-on-modal.

### 4.5 Board — `/b/:id`

```
[shell]
┌──────────────────────────────────────────────────────────┐
│ # Field                                          🔍  ⋯   │  ← top bar
├──────────────────────────────────────────────────────────┤
│                                                              │
│  1987 ─────────────────────                                │  ← section label, in-canvas
│  ▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢  │
│  ▢▢▢▢▢▢▢▢▢▢▢▢▓▓▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢  │  ← ▓ = hovered cell,
│  ▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢  │    hover card floats
│  1988 ─────────────────────                                │    above it
│  ▢▢▢▢▢▓▓▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢  │
│                                                              │
│                                          [ − 42% + ⛶ ]    │  ← zoom bar, bottom-right
│  ┌ 12 selected ───────────────────────────────── × ▾ ┐    │  ← selection tray
│  │ [img][img][img][img][img][img][img][img]…  12/150 │    │
│  │ Start a sheet  Add to sheet…  Copy…  Download      │    │
│  └───────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────┘
```

- **Top bar** trailing: search icon opens a find/filter row that
  replaces the section labels' row (name/property search + one filter
  chip per active property, `year 1980–1990 ×`), with a live match count
  (`38 of 1,204`) and a "Select all matches" button. `⋯` holds Sort
  (name/uploaded/property, asc/desc — this board's current sort, plus
  "Set as board default" for whoever manages it) and Upload.
- **Map**: full-bleed canvas, `--surface-canvas`. Section labels
  (whatever property the sort groups by, e.g. year) render as sticky
  in-canvas headers at 0.5 zoom and coarser only — they are a reading
  aid for a zoomed-out map, not a fixed list. A section header's own
  context menu carries "Select this section". An image carrying any
  claim (a region or edge drawn on it by any sheet) gets a small
  corner glyph (4×4px accent dot, top-right of its cell) — the board's
  read of "the union of claims" (phase-6 missed feature).
  Default initial fit is at least 2–3 cell-rows tall regardless of the
  mathematically tightest fit (audit: the 1px-sliver finding) — clamp
  the initial `z` so the fit never goes coarser than shows fewer than 2
  rows.
- **Hover card** (image-graph's, ported): name + up to 4 properties,
  150ms delay, `--surface-overlay`, `--shadow-s`, appears above the cell,
  flips below if it would clip the top bar.
- **Zoom bar**: bottom-right, floats over the canvas, never resizes it —
  `[ − ] [ 42% ] [ + ] [ ⛶ ]`, exactly image-graph's `.image-graph-zoom`
  shape (§2.5 radii, `--shadow-m`). The `%` cell shows current zoom and
  is itself a button: click to reset to 100%; the `⛶` fits everything.
  This is audit's top blocker fix — today there is no on-screen control
  at all.
- **Selection tray**: bottom, full width minus the zoom bar's corner,
  `--surface-raised`, `--radius-l` top corners only, `--shadow-m`. Header
  row: `"{n} selected"`, a count-against-cap when a sheet action is in
  play (`112 / 150`), a collapse chevron, a `×` clear. Body: a horizontal
  strip of 56×56px thumbnails in selection order, drag-to-reorder,
  each with a small `×` corner to remove one; hovering a thumbnail
  flashes its cell on the map (accent outline, 400ms). Footer: the four
  actions as buttons — `Start a sheet`, `Add to sheet…`, `Copy to
  another board…`, `Download`. Empty selection collapses the tray to a
  40px pill reading nothing (no "0 selected" — an empty tray is simply
  not there, `better-writing`'s "never park persistent information in an
  empty state"). The tray never covers more than 30% of viewport height;
  past ~40 thumbnails the strip scrolls horizontally rather than
  growing taller.
- **Detail panel** (right column, board): selecting exactly one image
  swaps "Who's here" for that image's detail — thumbnail, name,
  properties (image-graph's name·format·value·remove grid, §5.3),
  "Explore" (goes to the sheet with the most claims on it, or opens the
  thread browser if it's on several), and a **Claims** section: every
  claim on this image, grouped by sheet — "First pass: 2 regions, 1
  edge → image-142 (resembles)" — each row a link to that sheet.
- **Explore** no longer silently replaces the selection (audit: major
  finding). Choosing "Explore neighbourhood" on an image with an
  existing multi-image selection asks first via an inline toast, not a
  blocking modal: `"Exploring will replace your 2-image selection.
  [ Explore ]  [ Keep selection ]"`, 8s auto-dismiss to `Keep selection`.
- Loading/error states: see §4.10.

### 4.6 Board settings (modal)

```
┌──────────────────────────────────────────┐
│ Board settings — Finds                ×  │
├──────────────────────────────────────────┤
│  Name        [ Finds                  ]  │
│  Visibility  ( ) Open  (•) Private        │
│                                            │
│  Allowlist (private only)                 │
│  ┌──────────────────────────────────┐    │
│  │ ☑ owner@…                         │    │
│  │ ☑ member@…                        │    │
│  │ ☐ listed@…                        │    │
│  └──────────────────────────────────┘    │
│                                            │
│  Default sort  [ uploaded ▾ ] [ desc ▾ ]  │
│                                            │
│  ──────────────────────────────────────   │
│  Danger zone                              │
│  [ Delete this board ]                    │
└──────────────────────────────────────────┘
```

Checkbox list, not the plain table row from the audit — each row's whole
width is the hit target, per `better-accessibility`'s "label and control
share one hit target". Delete requires typing the board's name, same
pattern as the group's danger zone.

### 4.7 Sheet — `/s/:id`

```
[shell]
┌──────────────────────────────────────────────────┬──────────┐
│ # Field › First pass              ◀ Faces ▶  ⋯   │ Connection│
├────────────────────────────────────────────────────┤ (edge)   │
│                                                      │          │
│   [img]───resembles──▶[img]                        │ Source   │
│      ┊                    ┊                          │ img-053  │
│   ╌╌╌╌╌ (foreign, dashed) ┊                          │ Target   │
│      ┊                [img]                          │ img-091  │
│                                                      │ Arrow    │
│                                                      │ [None ▾] │
│                                                      │          │
│                                                      │ Properties│
│                                                      │ relation │
│                                                      │ [resembl…]│
│                                                      │ + Add    │
│                                                      │          │
│                                                      │ [ Save ] │
│              ┌──────────────────────────────┐      │──────────│
│              │ ▤ Select  ▢ Region  ↗ Edge  ✋│      │ Dangling │
│              │ [− 100% +]  [↶][↷]            │      │ · edge → │
│              └──────────────────────────────┘      │  deleted │
└────────────────────────────────────────────────────┴──────────┘
```

- **Top bar**: breadcrumb as usual, then a webring strip — `◀ Faces ▶`
  where `Faces` is the sibling sheet on the same board in creation
  order, prev/next wrapping around (phase-6's webring-style nav,
  literal). `⋯` holds Rename, Archive, "Show on board" (returns to the
  board with this sheet's images selected, map scrolled to the first —
  the Selection spec's own item).
- **Canvas**: full-bleed, `--surface-canvas`, the Excalidraw or native
  adapter behind the `CanvasHandle` seam (`sheet-canvas-seam.md`) — this
  design doesn't touch which adapter renders; it fixes what sits over
  it. Own regions/edges solid in `--claim-own`/`--claim-edge`. Foreign
  claims dashed `--claim-foreign`, drawn by the overlay
  (`foreign-never-in-scene.md`), with de-collision: a foreign label that
  would overlap another foreign label, an image caption, or an own
  label stays hidden until its shape is hovered or selected — ported
  from image-graph's "labels avoid images, captions, other labels;
  crowded labels stay hidden" (audit: moderate finding, the "First pass"
  screenshot's label pileup).
- **Toolbar**: floating, bottom-centre, solid `--surface-raised`
  background (not translucent — audit finding: content showed through),
  `--shadow-m`, `--radius-m`. Tool group (Select/Region/Edge/Pan) as one
  bordered strip exactly like image-graph's `.image-graph-tools`, the
  active tool filled `--accent`. Then the zoom cluster
  (`[−][100%][+]`), then undo/redo. Below 768px this wraps to two rows
  rather than clipping (audit: blocker on mobile — "Edge" read as
  "dge").
- **Inspector** (right column): exactly image-graph's shape — identity
  (thumbnail/name for an image, source→target for an edge), action
  buttons, fields (a caption column + control column grid), a
  `Properties` section as the name·format·value·remove table, a sticky
  footer with `Save` + inline status ("Saved" / "{n} properties need
  attention"). A foreign region shows the read-only `foreignInspector`
  shape: identity, "Open in source sheet", attached-note list, no edit
  controls, no delete.
- **Relation filter**: below the inspector when nothing is selected — a
  list of every relation used on this sheet plus "All relations";
  choosing one dims every other connection's stroke to 30% opacity
  (image-graph's `filter` dims, never removes — phase-6 spec, literal).
- **Dangling list**: below the relation filter — every edge on this
  sheet whose end is gone, one row each (`"→ image-091 (missing)"` or
  `"→ a region deleted in First pass"`), a `Remove` button per row (the
  only way a dangling edge disappears — never automatic).
- **Presence strip**: a thin row above the toolbar, one dot per active
  viewer in their presence colour + name, hover shows their current
  selection outlined on the canvas in their colour.
- Blank-scene-on-create race (audit blocker): the canvas renders nothing
  until a `loaded` flag from the room join resolves, and until then the
  canvas area shows a centred `Loading "{name}"…` in `--text-secondary`
  — never a bare empty scene that looks identical to "done, and empty."

### 4.8 Thread browser (a board's sheets)

Reached from the channel column's "See all sheets" (appears once a
board has more sheets than fit the nested list, ~8) or from the board's
`⋯` menu.

```
[shell]
┌──────────────────────────────────────────────────────────┐
│ # Field › Sheets                                          │
├──────────────────────────────────────────────────────────┤
│  Active                                                     │
│  ┌────────────────────────────────────────────────────┐  │
│  │[▢▢▢] First pass          12 images · Alex, Micah      │  │
│  │      Last activity 2h ago                    ▶       │  │
│  ├────────────────────────────────────────────────────┤  │
│  │[▢▢▢] Faces               8 images · Sam                │  │
│  │      Last activity yesterday                  ▶       │  │
│  └────────────────────────────────────────────────────┘  │
│                                                              │
│  Archived (3)                                     [ Show ]  │
└──────────────────────────────────────────────────────────┘
```

Each row: a 3-thumbnail preview strip of the sheet's first images, name
(bold if unread by the viewer — server-side `sheet_reads`), image count,
who's been in it (up to 3 presence-coloured initials + "+2"), last
activity relative time. Archived sheets collapse behind "Show" and are
still searchable by the quick switcher. Every row opens the sheet;
nothing here edits.

### 4.9 Copy a foreign claim

Triggered from a foreign region/edge's context menu ("Copy" — §5.4) or
its overlay hover card.

```
┌────────────────────────────────────────────┐
│ Copy this claim                          ×  │
├────────────────────────────────────────────┤
│  From "First pass" · region on image-053     │
│                                                │
│  ☑ Geometry              (always copied)      │
│  ☑ Label            "north wall"              │
│  ☑ Properties                                 │
│     ☑ material        "sandstone"             │
│     ☐ confidence      "0.8"                   │
│  ☑ Connections (for an edge)                  │
│     ☑ → image-091 (resembles)                 │
│                                                │
│              [ Cancel ]  [ Copy ]             │
└────────────────────────────────────────────┘
```

Geometry is checked and disabled — a copy with no shape isn't a claim.
Every other row is independently toggleable, per-property for the
Properties group (phase-6's spec, literal). `Copy` creates an ordinary
own claim on the current sheet with no reference to its origin
(`foreign-never-in-scene.md`'s "the copy is an ordinary own region from
the moment it exists").

### 4.10 Error and empty states

| Case | Shown | Inside |
| --- | --- | --- |
| 403, board not on your allowlist | Full main-pane message, shell intact | "You're not on Finds' list. Ask an owner or admin of Lab for access." + `[ Back to Lab ]` |
| 403, not a group member | Same shape | "You're not a member of this group." + `[ Back to your groups ]` |
| 404, board/sheet/group not found | Same shape | "This board doesn't exist, or it's been deleted." + `[ Back to Lab ]` |
| 404, group not found | Same shape, action cards hidden entirely (audit: major — don't show working forms under a real error) | "This group doesn't exist." + `[ Back to your groups ]` |
| 500 | Same shape | "Something broke on our end. Request id `a1b2c3`." + `[ Try again ]` — the request id so a bug report is actionable, never blamed on the user |
| Sheet room join denied | Same shape (not real-time jargon) | "This sheet doesn't exist, or it's been deleted." |
| Offline / reconnecting (sheet) | A thin banner at the top of the canvas, `--danger` left border, doesn't block the canvas | "Reconnecting… your changes are saved locally." → "Back online." (2s, then fades) |
| Board, 0 images | Canvas centre | "Nothing uploaded yet." + `[ Upload images ]` |
| Board, 0 matches (find/filter) | Replaces the map | "No matches for 'quarterly'. [ Clear filters ]" |
| Sheet list, 0 sheets | Channel column, under the board | "No sheets yet." + the "Start a sheet" row (§3.1) is itself the action, no duplicate button |
| Group, 0 boards | Homepage | the "under construction" block (§4.3) |
| Selection tray, 0 selected | Collapses entirely (§4.5) — not an empty state, an absence |

Every loading state that can hang (board/sheet fetch) gets a 10s
timeout that converts silently-forever "loading…" into the 500 shape
with "This is taking longer than expected." replacing the request-id
line — the audit's single worst-hit finding (blocker, 5× reproductions)
was a board that never resolves either way.

## 5. Interaction specs

### 5.1 Selection — every method

| Method | Result |
| --- | --- |
| Click a cell | Toggle that image; clears the rest unless a modifier is held |
| Shift+click | Extend a rank range from the last-clicked image, under the current sort |
| Ctrl/Cmd+click | Toggle that image without clearing others |
| Drag a band (default drag, or the Select tool) | Select every cell the band covers, row-major |
| Shift+drag | Same band-select, without needing the Select tool active |
| Section header → "Select this section" | Every image in that section (e.g. all of 1987) |
| Find/filter → "Select all matches" | Every matching image, capped at `SHEET_LIMIT` |
| Image detail → "Select neighbourhood" | Hops 1–3 (a stepper in the panel), optional relation filter |
| Image detail → "Select everything on sheet X" | Every image sheet X holds |
| Image detail → "Select images with claims" | Every image carrying at least one region or edge |
| Sheet → "Show on board" | Returns to the board with that sheet's images selected, map scrolled/fit to the first |
| `Ctrl+A` / a "Select all" menu item | Every image on the board (capped, same as "select all matches" with no filter) |
| `Ctrl+Z` / `Ctrl+Shift+Z` on the board | Undo/redo the SELECTION only — nothing else on the board is undoable |
| `Escape` | Clear the selection |
| Presence → "Take their selection" | Copies another viewer's selection into yours (replaces, doesn't merge) |

Range and band selects resolve server-side
(`POST /boards/:id/selection/range {sort, fromRank, toRank}`) so a
million-cell board never pages ranks to the client; "select all matches"
returns ids straight from the find query. A large selection's map
outline draws from rank ranges, not one shape per image.

**The tray.** Bottom of the board (§4.5), collapses when empty. Order is
selection order (click/drag/action order), drag-to-reorder inside the
tray changes it — that order becomes a new sheet's initial grid layout,
or its ring order when the selection came from "Select neighbourhood".
Each thumbnail: hover flashes its cell (400ms accent outline), click
pans/zooms the map to it, `×` removes it from the selection. Header
shows `"{n} selected"`; once a sheet-producing action is chosen, it
becomes `"{n} / {SHEET_LIMIT}"`.

**Over the cap.** No action is ever refused outright. The button itself
states the truncation: `Start a sheet with the first 150 of 212`,
`Add the first 38 of 50 (112 already on this sheet)`. Choosing it
proceeds with exactly that count, ordered by tray order; "Download" has
no cap (a zip of originals, whatever the count).

**Others' selections.** A viewer's hovered/selected images show to
others as a faint cell outline in the viewer's presence colour with
their name in a small trailing tag at the first cell — the same visual
as the image-graph screenshot's purple "Starting image" tag, generalised
to 8 colours.

### 5.2 Board Actions menu / right-click

Grouped exactly as image-graph's `menu()` groups them — build sections
with a `section()` helper that only inserts a separator when the
previous group actually added an item, never a leading or trailing one.
Reachable identically from: the `⋯` "Actions" button in the top bar
(opens at the button), right-click on the canvas, and long-press on
touch — one function, three call sites, per the one-action-three-surfaces
principle. Item set, in order (hit target = cell under pointer, or the
current selection when the target is itself selected):

**On an image (or the current multi-selection if the target is in it):**
1. Explore connections *(if the image carries any claim)*
2. Select neighbourhood…
— section —
3. Move to sheet… *(only if already on ≥1 sheet — jumps there)*
4. Start a sheet
5. Add to sheet…
— section —
6. Open image
7. Open companion note
— section —
8. Properties
— section —
9. Copy to another board…
10. Download

**On empty canvas (nothing under the pointer):**
1. Fit everything
2. Zoom to the selection *(if a selection exists)*
— section —
3. Select all matches *(if a filter is active)*
4. Clear selection *(if one exists)*
— section —
5. Upload images
6. Set default sort… *(board managers only)*
— section —
7. Undo selection / Redo selection *(labelled, as in image-graph — `Undo select 12 images`)*

**On a foreign-carrying image's corner glyph:** opens straight to the
Claims list in the detail panel rather than a menu — it's a shortcut
into the panel, not a new menu surface.

### 5.3 Sheet Actions menu / right-click

Same three-surface rule. Item set:

**On an own region:**
1. Connect from here
2. Properties
3. Create image from region
— section —
4. Move / resize *(sets the Region tool with this region grabbed)*
— section —
5. Delete region and its connections

**On a foreign region:**
1. Copy… *(opens §4.9)*
2. Open in source sheet
3. Create image from region
— section —
4. Open in Image Annotation *(if the region came from that plugin's own interop — n/a on the web app; omitted here, kept only as the plugin-parity note for anyone porting inspector code)*

**On an edge (own):**
1. Properties
— section —
2. Explore every "{relation}" connection *(jumps to board, selects every image joined by that relation anywhere)*
— section —
3. Delete connection

**On an image element:**
1. Connect from here
2. Draw rectangle region
3. Draw polygon region
4. Properties
— section —
5. Return this image to the grid *(only if it was moved off its laid-out position)*

**On empty canvas:**
1. Select tool / Region tool / Edge tool / Pan tool
— section —
2. Fit everything
— section —
3. Relation filter…
— section —
4. Undo / Redo
— section —
5. Save as image *(visual snapshot — this app has no Canvas export; keep the one export it does have here, same slot)*

Delete is always last, its own section, never grouped with anything
else — same placement image-graph uses, matching Obsidian's own menu
convention.

### 5.4 Keyboard, sheet

| Key | Action |
| --- | --- |
| `V` | Select tool |
| `R` | Region tool |
| `E` | Edge tool |
| `H` (hold Space also works, mid-drag) | Pan |
| `Delete`/`Backspace` | Delete selected region/edge (never an image) |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / redo the scene |
| `I` | Open the inspector for the current selection |
| `?` | Shortcut-help overlay |
| `Escape` | Deselect; close the inspector if nothing is selected |

## 6. Copy

Sentence case throughout; verb-first buttons; no exclamation marks;
errors state the fix beside the field that failed (`better-writing`).

### Buttons

| Label | Where |
| --- | --- |
| Sign in / Sign up | Sign-in, join |
| Create a group | Groups |
| Join with a link | Groups (replaces "accept an invitation" by id — audit finding) |
| Create a board | Group homepage / settings |
| Upload images | Board top bar, empty board |
| Start a sheet | Selection tray, image/section menus, channel column |
| Add to sheet… | Selection tray |
| Copy to another board… | Selection tray |
| Download | Selection tray |
| Select all matches | Find/filter bar |
| Explore connections | Image detail, image menu |
| Select neighbourhood… | Image menu |
| Take their selection | Presence row |
| Save | Sheet inspector footer |
| Copy | Copy-foreign-claim dialog |
| Cancel | Every dialog |
| Remove | Allowlist row, tray thumbnail, dangling-edge row |
| Confirm | Role change, member removal, board/sheet/group delete |
| Delete this board / Delete this group | Danger zones |
| Sign *(the guestbook)* | Group homepage |
| Try again | 500 page |
| Back to Lab / Back to your groups | 403/404 pages |
| Clear filters | Zero-match state |
| Show *(archived sheets)* | Thread browser |

### Empty states

| Place | Copy |
| --- | --- |
| Board, no images | "Nothing uploaded yet." / "Upload your group's first images to start mapping them." → `[ Upload images ]` |
| Board, no matches | "No matches for '{query}'." → `[ Clear filters ]` |
| Sheet list, no sheets | "No sheets yet." / "A sheet is where a selection becomes an argument." |
| Group, no boards | "Under construction." / "This group hasn't started a board yet." → `[ Create a board ]` |
| Sheet inspector, nothing selected | "Select an image, a region or a connection." |
| Sheet, no dangling claims | *(section hidden entirely — nothing to say)* |
| Guestbook, no activity | "Nobody's signed the guestbook yet." |
| Selection tray | *(collapses — no copy)* |

### Errors

| Case | Copy |
| --- | --- |
| Wrong email/password | "That email or password isn't right." |
| Invite: blank email submitted as a request | *(fixed at the source — the client omits `email` entirely rather than sending `''`; no error to write)* |
| Invite: address already invited | "{email} already has an invitation. [ Copy the link ]" |
| 403, board | "You're not on {board}'s list. Ask an owner or admin of {group} for access." |
| 403, group | "You're not a member of this group." |
| 404, board/sheet | "This {board/sheet} doesn't exist, or it's been deleted." |
| 404, group | "This group doesn't exist." |
| 500 | "Something broke on our end. Request id {id}." |
| Loading timeout | "This is taking longer than expected. Request id {id}." |
| Sheet offline | "Reconnecting… your changes are saved locally." |
| Sheet back online | "Back online." |
| Sheet property save failure | "Couldn't save. Try again." *(inline, in the inspector footer — matches image-graph's own fallback string)* |
| Sheet property row invalid | "{n} propert{y/ies} need{s} attention." *(inline count, live as typed)* |
| Delete pressed on nothing selected | "Select a region or a connection to delete." |
| Delete pressed on an image (regions/edges only are deletable) | "Delete removes a region or a connection. {That image / Those n images} stay{s} on the board." |
| Explore about to replace a selection | "Exploring will replace your {n}-image selection." → `[ Explore ]` `[ Keep selection ]` |
| Over the selection cap | *(not an error — the button states the truncation, §5.1)* |

## 7. Build order

Each slice ships independently reviewable and screenshot-checked before
the next starts (`../phases/6-product.md`'s own process step 3).

**Slice 1 — Shell**
Components: group rail, channel column (boards + nested sheets, static
data), top bar with breadcrumb, right-column frame (empty), quick
switcher, the three breakpoints' collapse behaviour.
Smoke: every existing route renders inside the shell instead of a bare
page; resizing 1280→768→390 collapses right column then merges rail
into the drawer, nothing clips; `Ctrl+K` opens and navigates.

**Slice 2 — Board + selection**
Components: zoom bar, hover card (ported), section labels, corner claim
glyph, find/filter bar, detail panel, selection tray, Actions
menu/right-click (§5.2), selection server endpoints
(`board_selections`, `/selection/range`), Explore's replace-warning
toast, initial-fit clamp, 10s loading timeout → error shape.
Smoke: the scripted Selection walk from phase-6 (click, range, band,
section, match, neighbourhood, "show on board"; sort change keeps the
same images selected; reload keeps them; tray reorder changes a new
sheet's layout; over-cap shows the honest count); a private board a
viewer isn't on renders the 403 shape, not an infinite spinner.

**Slice 3 — Sheet chrome**
Components: solid toolbar, inspector reshaped to the property-table
grid, foreign-claim label de-collision, relation filter, dangling list,
presence strip, copy-foreign-claim dialog, blank-scene loading guard,
webring prev/next, keyboard map (§5.4), Actions menu/right-click
(§5.3).
Smoke: a sheet with 3 sheets' worth of foreign claims on one image shows
no overlapping labels at default zoom; a real pointer drag across a
foreign shape moves nothing (existing e2e scenario, unaffected by this
slice — verify it still passes); creating a sheet never shows a blank
scene before its 2-image layout appears.

**Slice 4 — Threads**
Components: thread browser page, unread bold + activity dot (channel
column and thread browser both read `sheet_reads`), "Start a sheet"
naming-in-place, archive/reopen, sheet header's parent breadcrumb.
Smoke: creating a sheet from the tray puts it in the channel column
unread-bold for every other member and not for its creator; archiving
removes it from the column but the quick switcher and thread browser
still find it.

**Slice 5 — Group homepage + themes**
Components: banner, visitor-counter strip, board badges (sorted by
activity), guestbook (read + Sign), "under construction" empty state,
the 4 GeoCities themes, group-settings theme picker.
Smoke: switching a group's theme changes only `.geo-surface` — a
screenshot diff of the same group's board page must be pixel-identical
before/after a theme change; each theme's rendered banner/heading/link
measured contrast matches §2.6's table.

**Slice 6 — Remaining missed features + error/empty states**
Components: typed properties (`date`, `list`) through the inspector,
sort/filter indexes created on first use, presence-by-image on the
board, board default-sort control, every remaining error/empty state
from §4.10's table, pluralization audit pass (`{n} image{s}` throughout,
not just the one the audit caught), `RenameInline` hover-pencil
affordance, real names in presence chips.
Smoke: the phase-6 checklist item verbatim — 404, 403 with the "ask
{creator}" copy, 500 with request id, offline/reconnecting on the sheet,
and every empty group/board/sheet state — walked as each fixture user,
screenshotted, diffed against this document's §4.10 table.
