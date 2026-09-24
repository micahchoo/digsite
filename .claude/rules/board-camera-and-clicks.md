---
scope: [web/src/pages/Board.tsx]
tags: [board, deck.gl, camera, gestures]
priority: high
source: hand-written
checks:
  - require: 'onViewStateChange: \(\{ viewState \}\) => setView\('
    in: web/src/pages/Board.tsx
    message: the board's pan must hand deck its camera back through setView
  - require: 'eventRecognizerOptions'
    in: web/src/pages/Board.tsx
    message: the board's click and pan thresholds must stay set
---

# board: one way to move the camera, and a click that tolerates a hand

Two defects lived in the Deck constructor, both found 2026-09-24 with a
Playwright loop of real mouse input (walk claim 8b keeps them shut).

- **Every camera change goes through `setView`, deck's own pans included.**
  Once `setView` hands deck a `viewState` (a fly-to, the zoom buttons, Fit),
  the map is controlled. A pan that was only noted (`noteView`) left deck
  on the old camera: the map froze after its first programmatic move. Do
  not call `noteView` alone from a deck callback.
- **A click is a click until it moves `DRAG_THRESHOLD` px, held up to
  `CLICK_HOLD_MS`.** deck.gl's defaults (pan from 1 px, tap within 250 ms)
  turned a one-pixel wobble or a slow press into nothing: clicks "worked
  sometimes". The threshold is the sheet's (`gestures.ts`), so both
  surfaces answer one hand the same way. The hold stays under the touch
  long-press (550 ms), which opens the menu.

A test that clicks a cell centre and releases at once will pass with both
defects present. Drift the pointer a few pixels, hold, and move the camera
by code first.

Verify with `bun run e2e:fresh src/sense-claims.ts` (claim 8b).
