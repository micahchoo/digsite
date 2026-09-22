# HANDOFF — digsite product repo

Updated 2026-09-22 evening. Phases 0–4 done and committed; the native canvas adapter (phase 2 §8) is in flight; phase 5 (hardening) is where the autonomous run stops. Roadmap: `docs/roadmap.md`.

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
10. Phase 2 web step 2 — DONE, committed; `e2e/src/sheet-hour.ts` dry-run against the stub only.
11. Seam linter (`scripts/seams/lint.ts`, checks in each rule's frontmatter, `bun run lint:seams`, part of `bun run check`) — DONE, committed.
12. Phase 3 server — DONE, committed; `groups-life.ts` 9/9 for real.
13. Phase 4 (storage port fs/s3, deploy/, backups, health) — DONE, committed (merged from a worktree branch).
14. Canvas seam: Excalidraw isolated in `web/src/sheet/canvas/` — DONE; then four real-server defects fixed (snapshot index order, stale overlay after a programmatic viewport change, first-change-per-frame drop, float4 fractions).
15. Real-server suites on the demo (`../demo`, a worktree on main, server 8800 + vite 5180 running in the background): `run.ts` 8/10 (1 and 2 fail only on fixture debris), `sheet-hour.ts` 7/7, `groups-life.ts` 9/9.
16. IN FLIGHT: `web/src/sheet/canvas/native/`, image-graph's canvas as a second adapter behind `CanvasHandle`, selected by `VITE_CANVAS=native`.

The demo worktree at `../demo` runs the app for the owner; move it with `git checkout --detach main` and restart the server by pid when server code changes (vite reloads web on its own).

Crash note: the session died twice (02:05, 08:08) from the kernel OOM-killing a `bun` worker at ~84 GB during the scatter materialisation; a third at 93 GB was killed by hand. The fix agent must cap memory (`MATERIALISE_BUDGET_MB`) and run heavy steps under `systemd-run --user --scope -p MemoryMax=40G`.

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
