---
scope: [web/src/**, shared/src/report/**, shared/src/icons.ts]
tags: [ui, icons]
priority: medium
source: hand-written
checks:
  - forbid: '^(?!\s*(//|\*|/\*|\{/\*)).*[→←↔⇄⇆↳↪↵⏎✕✖✓✔⋯▸▾▶◀▲▼•●○◆★☆↗↘]'
    in: [web/src/**, shared/src/report/**]
    message: a typed glyph used as an icon; draw it with components/Icon.tsx (or shared/icons.ts in a report)
---

# ui: an icon is drawn, never typed

A typed `→`, `✕` or `⋯` renders in whatever font the reader has, at that
font's weight and baseline, so no two match each other or the drawn icons
beside them. Every icon in the app is `components/Icon.tsx`: one 20-unit
grid, one stroke. A report document cannot import the web, so the
direction paths it shares with `Icon` live in `shared/src/icons.ts`
(`DIRECTION_PATHS`); a new shared glyph goes there, not into a second copy.

Typography is not an icon: `400 × 200` (multiplication), `·` between
facts, `…` at the end of "Add to sheet…", `+3 more` as a count stay text.

A drawn icon inside text names itself for a screen reader
(`aria-label`, e.g. `DIRECTION_WORDS`); a decorative one is `aria-hidden`.

Verify with `bun run lint:seams`.
