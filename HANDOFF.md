# HANDOFF — digsite product repo

Updated 2026-09-22 early. Phase 0 done; phase 1 server and web halves committed; the 1M scale run and phase 2's sheet tools are in flight. Roadmap: `docs/roadmap.md`.

## Where things stand

The repo was scaffolded from the brainstorm record
(`../.brainstorm/sessions/0001-shared-image-canvas.md`) and the three
prototypes' numbers, not their code. Build order, each step by a Sonnet
subagent against `docs/design.md`:

1. root + `shared/` — DONE. 41 tests, tsc and Biome clean.
2. `server/` and `web/` — DONE, each committed.
3. `e2e/` walking-skeleton run — DONE, 10/10 (`e2e/RESULTS.md`).
4. Phase 1 server (worker, tus, materialise, sections) — DONE, committed.
5. Phase 1 web (sections, hover, selection, detail, uploads) — DONE, committed.
6. Phase 1 scale run (`server/scripts/synth.ts`, `measure-map.ts` → `docs/measurements/phase-1-map.md`) — IN FLIGHT on ports 8801/5181.
7. Phase 2 web (drawing, inspector, dangling, rename) — DONE, committed.
8. Phase 3 web (join, members, allowlist, delete flows) — DONE, committed; the stub in `web/stub/server.ts` is the contract the server halves must match.
9. Phase 2 server (presence, neighbourhood, sheet stats + rename), phase 3 server (invitations, roles, delete + footprints), phase 4 (storage, deploy) — wait for the scale run to free `server/` and the DB.

Committed at each phase boundary on `main`, no attribution trailers (user instruction).

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
