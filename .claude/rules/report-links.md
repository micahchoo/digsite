---
scope: [server/src/reports/**, server/src/access/index.ts, web/src/pages/PublishedReport.tsx, web/src/board/BoardReports.tsx]
tags: [report, access, security, public]
priority: high
source: hand-written
checks:
  - require: 'share_token IS NOT NULL AS linked'
    in: server/src/reports/kept.ts
    message: the kept-report list must say whether a link exists, never hand out the token
  - forbid: 'share_token\s*(,|AS\s+token)'
    in: server/src/reports/**
    message: a query returns a report's share token; only publishReport may, once, to its maker
---

# reports: a link is the only public door, and it opens one report

`GET /published/:token` and `GET /published/:token/images/:id` are the only
routes in the app that answer without a session. The token is 32 random
bytes (`kept.ts#publishReport`); it is the whole permission, so:

- **Every failure is the same 404.** Unknown, revoked, expired and
  malformed tokens all read `no such report`
  (`access/index.ts#publishedReportForReading`). A revoked link must not be
  told apart from a guess.
- **The token is shown once.** `publishReport` returns it to whoever made
  the link; no list, no GET, no log carries it (the checks above). A lost
  link is replaced with a new one, which stops the old.
- **A link serves the report's own pictures and nothing else.** The image
  route checks the id against the KEPT data's `images` and the board, and
  refuses a picture gone missing since. It serves `boards/routes.ts#previewOf`,
  the pixels a member sees, never the original.
- **Counted per link** (`limits.ts` `published`, `RATE_PUBLISHED_PER_MIN`),
  since there is no user to count.
- **Who may publish is the board's manager** (`reportForPublishing` =
  `boardForManagingAllowlist`), decided 2026-09-23: a link shows the board's
  pictures to anyone holding it, which is the allowlist's own question. The
  maker of a report may keep, remove and stop its link, not make one.

The public page (`/r/:token`) shows the document in an iframe with
`sandbox="allow-scripts …"` and NO `allow-same-origin`: the viewer runs,
and nothing in the frame can read the app's session cookie.

A kept report's `data` is never updated; `changesSince` gathers the same
scope again and compares (`shared/report/changes.ts`). Removing a sheet
leaves its kept reports; removing the board takes them (`removal.ts`).

Verify with `cd server && bun test reports-routes access routes-audit`, and
walk claim 13c of `bun run e2e:fresh src/sense-claims.ts`, which reads the
link from a browser context with no cookies and sees it stop.
