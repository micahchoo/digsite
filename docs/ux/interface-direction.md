# Interface direction, 22 September 2026

The user rejected the current UI and its mockups. Treat the old mockups as
historical proposals, not visual acceptance criteria.

The main reference is the local `image-graph` Obsidian plugin:
`/mnt/Ghar/2TA/DevStuff/notebook/obsidian-developing-plugins/image-graph`.
Read its `styles.css`, `src/view.ts`, and screenshots in `docs/`.
The shared product decisions remain in `../../../.brainstorm/`.

## What to carry over

- Give images most of the workspace. Keep drawing controls compact.
- Float canvas controls and inspectors without moving the image coordinate system.
- Group related tools. Use short labels beside unfamiliar icons.
- Show image identity before properties: thumbnail, name, then supporting details.
- Use aligned property rows and subtle section rules instead of nested cards.
- Keep selection, save status, and zoom visible without exposing debug counters.
- On narrow screens, use drawers and scrolling tool groups without clipping actions.

The board remains a fixed server map with 1,024 columns. Do not turn a small
fixture into a responsive gallery to make a screenshot look fuller.
Sheets remain shared spaces for arranging images and adding claims.

## Acceptance

Review rendered boards, selections, inspectors, sheets, and group navigation.
Check desktop and narrow screens. Verify keyboard access and both color themes.
Use the real server for persistence and collaboration checks. Stub screenshots
alone cannot establish that these workflows work.
