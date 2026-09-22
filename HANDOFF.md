# HANDOFF — digsite product repo

Updated 2026-09-21, during the first build.

## Where things stand

The repo was scaffolded from the brainstorm record
(`../.brainstorm/sessions/0001-shared-image-canvas.md`) and the three
prototypes' numbers, not their code. Build order, each step by a Sonnet
subagent against `docs/design.md`:

1. root + `shared/` — DONE. 41 tests, tsc and Biome clean.
2. `server/` and `web/` — IN FLIGHT, in parallel.
3. `e2e/` walking-skeleton run, then `README.md` — NOT STARTED.

No git commit has been made; the first commit is the owner's.

## Read first

`CONTEXT.md` (the words), `docs/design.md` (the contract), the four
rules in `.claude/rules/` (the seams). Each rule names the measurement
that justifies it and the test that verifies it.

## Infra

- Product DB: compose service `db`, container `digsite-db`,
  `127.0.0.1:5440`, user/pass/db `digsite`, volume `digsite-db`. Loopback
  only on purpose (Docker ports bypass UFW on this machine).
- Prototype DB `digsite-pg` on `0.0.0.0:5432` may still be running and is
  LAN-exposed; it is not used here. `deploy-postgres-1` (5433) and
  `penpot-postgres` are other projects; never touch.
- Ports: server 8800, web 5180. The prototypes used 8787/8790/8791 and
  5173/5174; the board viewer's Vite on 5173 may still be up.

## Decisions carried into code

- Any member may create a board, private included; the plugin's `member`
  role is widened for team operations; `access/boardForManagingAllowlist`
  is the real gate.
- Foreign claims live on an overlay, never in the Excalidraw scene.
- Fractions are the fact; pixels are derived from the image's current
  rect at render, and `copyForeign` places against the image now.
- An org owner not on a private board's allowlist is denied.

## Next after the build

Materialise coarse tile levels per sort (the next lever named in
`tile-cache-is-for-the-second-viewer.md`); upload pipeline as a worker;
group-by section headers on the map; the parked private staging space.
