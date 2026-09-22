# HANDOFF — digsite product repo

Updated 2026-09-22 evening. Phases 0–4 done and committed; the native canvas adapter (phase 2 §8) is in flight; phase 5 (hardening) is where the autonomous run stops. Roadmap: `docs/roadmap.md`.

## Where things stand (2026-09-22, paused by the owner)

Committed on `main` (49 commits): phases 0–4, phase 5 hardening
(access audit, limits, sessions, logs, metrics, CI with a fresh-database
e2e, scale debts, the canvas leak fix, ladder fairness, serialised rank
rebuilds), the UX audit and design (`docs/ux/`), the UX defect fixes,
and slice 1 of the design (the Discord shell).

PAUSED, UNCOMMITTED in the working tree — review the diff before
committing anything:
- Slice 2, board and selection (web/**, web/stub, shared/src/api.ts):
  the agent reported 11/11 smokes green just before it was stopped;
  its own final cleanup did not run.
- Phase 6 server work (server/**, migrations 0010+): stopped mid-way,
  last step was wiring property indexes into rank rebuild. Incomplete.

OPEN DEFECT: the demo server was OOM-killed at its 16 GB cap 11 s
after a restart on the leak-fixed code. Not startup (flat at 190 MB),
not a single tile per zoom. The request that did it never finished,
so it is not in the log. A 1 s RSS sampler writes to the session
scratchpad `demo-rss.log`; correlate a spike with the journal
(`journalctl --user -u digsite-demo-server`).

The demo runs as a user service: `systemctl --user status
digsite-demo-server` (16 GB cap), from `../demo` (a worktree on main);
vite for the demo on 5180 runs separately. Demo users use `password1`.

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
