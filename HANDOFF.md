# HANDOFF — digsite product repo

Updated 2026-09-22. Phases 0 done; 1 measured with three misses being fixed; 2 server done, web step 2 in flight; 3 web done. Roadmap: `docs/roadmap.md`.

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
6. Phase 1 scale run — DONE, committed (`docs/measurements/phase-1-map.md`): rank rebuild 6.5 s, materialise 277 s, coarse p95 10 ms miss target; causes diagnosed. FIX IN FLIGHT (drop the rank FK, scatter materialisation over pages with worker-thread PNG encoding, resident coarse tiles) on ports 8801/5181; uncommitted edits under `server/src/boards/**`, `worker/`, migration 0004.
7. Phase 2 web (drawing, inspector, dangling, rename) — DONE, committed.
8. Phase 3 web (join, members, allowlist, delete flows) — DONE, committed; the stub in `web/stub/server.ts` is the contract the server halves must match.
9. Phase 2 server (presence, neighbourhood, sheet stats + rename, ring layout, projection keeps dangling edges) — DONE, committed.
10. Phase 2 web step 2 (presence cursors, explore-from-here, copy connections, dangling foreign, `e2e/src/sheet-hour.ts`) — IN FLIGHT against the stub.
11. Phase 3 server (invitations, roles, delete + footprints, matching `web/stub/server.ts`) and phase 4 (storage, deploy) — queued behind the phase 1 fix (same board files).
12. Then: run `e2e` 10/10 and `sheet-hour.ts` against the real server; commit; phase 4.

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
