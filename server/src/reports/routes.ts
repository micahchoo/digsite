// Reports (CONTEXT.md "Report", "Kept report", "Published report"): what a
// scope's claims say, gathered on the server so a board's union can be read
// at all (gather.ts), kept with an id to be cited, and published by link to
// people outside the group (kept.ts).
//
//   GET    /sheets/:id/report            the sheet now     (?ids= a selection)
//   GET    /boards/:id/report            the board union   (?relation=, ?from=&to=)
//   POST   /boards/:id/reports           keep one          {scope?, title?}
//   GET    /boards/:id/reports           the board's kept reports
//   GET    /reports/:id                  a kept report, as kept
//   GET    /reports/:id/changes          what changed since
//   GET    /reports/:id/bundle           its evidence, as a zip (bundle.ts)
//   DELETE /reports/:id                  remove it
//   POST   /reports/:id/link             publish a link    {days?}
//   DELETE /reports/:id/link             revoke it
//   GET    /published/:token             the report, with no sign-in
//   GET    /published/:token/images/:id  one of its pictures
//
// Every one asks its intent first (access/index.ts); the two public ones
// ask `publishedReportForReading`, which takes a token, not a user.
import type { ReportScope } from '@digsite/shared';
import type { ListReportsResponse } from '@digsite/shared/api';
import {
  AccessDenied,
  boardForViewing,
  publishedReportForReading,
  reportForManaging,
  reportForPublishing,
  reportForViewing,
  sheetForEditing,
} from '../access/index.ts';
import { previewOf } from '../boards/routes.ts';
import { pool } from '../db/pool.ts';
import { env } from '../env.ts';
import {
  type Ctx,
  type Router,
  json,
  param,
  readJsonBody,
  requireAuth,
} from '../http.ts';
import { checkLimit, tooManyRequests } from '../limits.ts';
import { writeBundle } from './bundle.ts';
import { gatherReport } from './gather.ts';
import {
  LINK_DAYS,
  LINK_MAX_DAYS,
  changesSince,
  keepReport,
  keptData,
  publishReport,
  removeReport,
  reportsOn,
  revokeLink,
} from './kept.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IDS = 400;

async function nameOf(userId: string): Promise<string> {
  const { rows } = await pool.query<{ name: string; email: string }>(
    'SELECT name, email FROM "user" WHERE id = $1',
    [userId],
  );
  const r = rows[0];
  return r?.name || r?.email.split('@')[0] || 'someone';
}

function query(ctx: Ctx): URLSearchParams {
  return new URL(ctx.req.url ?? '', 'http://x').searchParams;
}

type Parsed = { scope: ReportScope } | { error: string };

/** A board's scope from plain fields: a path, a relation, or the whole
 * board. The same words in a query string and in a body. */
function boardScope(
  boardId: string,
  f: { relation?: unknown; from?: unknown; to?: unknown },
): Parsed {
  if (f.from !== undefined || f.to !== undefined) {
    if (
      typeof f.from !== 'string' ||
      typeof f.to !== 'string' ||
      !UUID.test(f.from) ||
      !UUID.test(f.to)
    )
      return { error: 'from and to are picture ids' };
    return { scope: { kind: 'path', boardId, from: f.from, to: f.to } };
  }
  const relation = typeof f.relation === 'string' ? f.relation.trim() : '';
  if (relation) return { scope: { kind: 'relation', boardId, relation } };
  return { scope: { kind: 'board', boardId } };
}

function idsOf(v: unknown): string[] | null {
  const ids = Array.isArray(v)
    ? v
    : typeof v === 'string'
      ? v.split(',')
      : null;
  if (!ids) return null;
  const clean = ids
    .filter((s): s is string => typeof s === 'string')
    .map((s) => s.trim())
    .filter(Boolean);
  return clean.length <= MAX_IDS ? clean : null;
}

/** The scope a keep asks for, checked against the board in the path: a
 * sheet's scope must name a sheet of this board the user may read. */
async function keptScope(
  userId: string,
  boardId: string,
  body: Record<string, unknown>,
): Promise<Parsed> {
  const s = (body.scope ?? {}) as Record<string, unknown>;
  if (s.kind === 'sheet' || s.kind === 'selection') {
    if (typeof s.sheetId !== 'string' || !UUID.test(s.sheetId))
      return { error: 'sheetId is a sheet id' };
    const sheet = await sheetForEditing(userId, s.sheetId);
    if (sheet.board_id !== boardId)
      return { error: 'that sheet is on another board' };
    if (s.kind === 'sheet')
      return { scope: { kind: 'sheet', sheetId: sheet.id } };
    const ids = idsOf(s.ids);
    if (!ids) return { error: `ids is a list of at most ${MAX_IDS}` };
    return { scope: { kind: 'selection', sheetId: sheet.id, ids } };
  }
  if (s.kind === 'path') return boardScope(boardId, { from: s.from, to: s.to });
  if (s.kind === 'relation')
    return boardScope(boardId, { relation: s.relation });
  return { scope: { kind: 'board', boardId } };
}

function titleOf(v: unknown): string | undefined {
  return typeof v === 'string' ? v.slice(0, 200) : undefined;
}

export function registerReportRoutes(router: Router) {
  router.get('/sheets/:id/report', async (ctx) => {
    const userId = requireAuth(ctx);
    const sheet = await sheetForEditing(userId, param(ctx, 'id'));
    const board = await boardForViewing(userId, sheet.board_id);
    const q = query(ctx);
    let scope: ReportScope = { kind: 'sheet', sheetId: sheet.id };
    if (q.has('ids')) {
      const ids = idsOf(q.get('ids'));
      if (!ids) return json(ctx.res, 400, { error: `at most ${MAX_IDS} ids` });
      scope = { kind: 'selection', sheetId: sheet.id, ids };
    }
    json(
      ctx.res,
      200,
      await gatherReport({
        scope,
        boardId: board.id,
        boardName: board.name,
        by: await nameOf(userId),
        origin: env.WEB_ORIGIN,
        title: titleOf(q.get('title')),
      }),
    );
  });

  router.get('/boards/:id/report', async (ctx) => {
    const userId = requireAuth(ctx);
    const board = await boardForViewing(userId, param(ctx, 'id'));
    const q = query(ctx);
    const parsed = boardScope(board.id, {
      relation: q.get('relation') ?? undefined,
      from: q.get('from') ?? undefined,
      to: q.get('to') ?? undefined,
    });
    if ('error' in parsed) return json(ctx.res, 400, parsed);
    json(
      ctx.res,
      200,
      await gatherReport({
        scope: parsed.scope,
        boardId: board.id,
        boardName: board.name,
        by: await nameOf(userId),
        origin: env.WEB_ORIGIN,
        title: titleOf(q.get('title')),
      }),
    );
  });

  router.post('/boards/:id/reports', async (ctx) => {
    const userId = requireAuth(ctx);
    const board = await boardForViewing(userId, param(ctx, 'id'));
    const body = ((await readJsonBody(ctx.req)) ?? {}) as Record<
      string,
      unknown
    >;
    const parsed = await keptScope(userId, board.id, body);
    if ('error' in parsed) return json(ctx.res, 400, parsed);
    const kept = await keepReport(
      {
        scope: parsed.scope,
        boardId: board.id,
        boardName: board.name,
        by: await nameOf(userId),
        origin: env.WEB_ORIGIN,
        title: titleOf(body.title),
      },
      userId,
    );
    json(ctx.res, 201, kept);
  });

  router.get('/boards/:id/reports', async (ctx) => {
    const userId = requireAuth(ctx);
    const board = await boardForViewing(userId, param(ctx, 'id'));
    const response: ListReportsResponse = {
      reports: await reportsOn(board.id),
    };
    json(ctx.res, 200, response);
  });

  router.get('/reports/:id', async (ctx) => {
    const userId = requireAuth(ctx);
    const report = await reportForViewing(userId, param(ctx, 'id'));
    json(ctx.res, 200, keptData(report));
  });

  router.get('/reports/:id/changes', async (ctx) => {
    const userId = requireAuth(ctx);
    const report = await reportForViewing(userId, param(ctx, 'id'));
    const board = await boardForViewing(userId, report.board_id);
    json(ctx.res, 200, await changesSince(report, board.name));
  });

  router.get('/reports/:id/bundle', async (ctx) => {
    const userId = requireAuth(ctx);
    const report = await reportForViewing(userId, param(ctx, 'id'));
    const data = keptData(report);
    const file = `${data.title.replace(/[^\p{L}\p{N} ._-]/gu, '') || 'report'} evidence.zip`;
    ctx.res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file)}`,
      'Cache-Control': 'private, no-store',
    });
    await writeBundle(data, report.board_id, (chunk) => ctx.res.write(chunk));
    ctx.res.end();
  });

  router.del('/reports/:id', async (ctx) => {
    const userId = requireAuth(ctx);
    const report = await reportForManaging(userId, param(ctx, 'id'));
    await removeReport(report.id);
    json(ctx.res, 200, { ok: true });
  });

  router.post('/reports/:id/link', async (ctx) => {
    const userId = requireAuth(ctx);
    const report = await reportForPublishing(userId, param(ctx, 'id'));
    const body = ((await readJsonBody(ctx.req)) ?? {}) as { days?: unknown };
    const days =
      body.days === null
        ? null
        : body.days === undefined
          ? LINK_DAYS
          : Number(body.days);
    if (
      days !== null &&
      !(Number.isInteger(days) && days >= 1 && days <= LINK_MAX_DAYS)
    )
      return json(ctx.res, 400, {
        error: `days is 1 to ${LINK_MAX_DAYS}, or null for no end`,
      });
    json(ctx.res, 200, await publishReport(report.id, userId, days));
  });

  router.del('/reports/:id/link', async (ctx) => {
    const userId = requireAuth(ctx);
    const report = await reportForManaging(userId, param(ctx, 'id'));
    await revokeLink(report.id);
    json(ctx.res, 200, { ok: true });
  });

  // -- public: the token is the permission ---------------------------------

  /** An unknown, revoked or expired link is a 404, whatever the reason. */
  async function published(ctx: Ctx) {
    const token = param(ctx, 'token');
    const limit = checkLimit('published', token);
    if (!limit.allowed) {
      tooManyRequests(ctx.res, 'published', limit.retryAfter);
      return null;
    }
    try {
      return await publishedReportForReading(token);
    } catch (err) {
      if (!(err instanceof AccessDenied)) throw err;
      json(ctx.res, 404, { error: 'no such report' });
      return null;
    }
  }

  router.get('/published/:token', async (ctx) => {
    const report = await published(ctx);
    if (!report) return;
    ctx.res.setHeader('Cache-Control', 'no-store');
    ctx.res.setHeader('X-Robots-Tag', 'noindex');
    json(ctx.res, 200, keptData(report));
  });

  router.get('/published/:token/images/:imageId', async (ctx) => {
    const report = await published(ctx);
    if (!report) return;
    // Only the pictures the report shows, and only while on the board.
    const imageId = param(ctx, 'imageId');
    const shown = keptData(report).images.some((img) => img.id === imageId);
    if (!shown) return json(ctx.res, 404, { error: 'not in this report' });
    const { rows } = await pool.query<{
      board_id: string;
      sha256: string;
      slot: number;
    }>(
      `SELECT board_id, sha256, slot FROM images
        WHERE id = $1 AND board_id = $2 AND missing = false`,
      [imageId, report.board_id],
    );
    const image = rows[0];
    const buf = image ? await previewOf(image) : null;
    if (!buf) return json(ctx.res, 404, { error: 'picture not available' });
    ctx.res.writeHead(200, {
      'Content-Type': 'image/png',
      'Cache-Control': 'private, max-age=300',
      'X-Robots-Tag': 'noindex',
    });
    ctx.res.end(buf);
  });
}
