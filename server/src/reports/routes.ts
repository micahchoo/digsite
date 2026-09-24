// Reports (CONTEXT.md "Report"): what a scope's claims say, gathered on the
// server so a board's union can be read at all (gather.ts). Access is the
// scope's own object: a sheet's report is read like its rows, a board's
// like the board. Nothing here writes.
//
//   GET /sheets/:id/report            the sheet        (?ids= a selection)
//   GET /boards/:id/report            the board union
//   GET /boards/:id/report?relation=  one relation, canonical
//   GET /boards/:id/report?from=&to=  the path between two pictures
import type { ReportScope } from '@digsite/shared';
import { boardForViewing, sheetForEditing } from '../access/index.ts';
import { pool } from '../db/pool.ts';
import { env } from '../env.ts';
import { type Router, json, param, requireAuth } from '../http.ts';
import { gatherReport } from './gather.ts';

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

function query(url: string): URLSearchParams {
  return new URL(url, 'http://x').searchParams;
}

export function registerReportRoutes(router: Router) {
  router.get('/sheets/:id/report', async (ctx) => {
    const userId = requireAuth(ctx);
    const sheet = await sheetForEditing(userId, param(ctx, 'id'));
    const board = await boardForViewing(userId, sheet.board_id);
    const q = query(ctx.req.url ?? '');
    const ids = (q.get('ids') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length > MAX_IDS)
      return json(ctx.res, 400, { error: `at most ${MAX_IDS} ids` });
    const scope: ReportScope = q.has('ids')
      ? { kind: 'selection', sheetId: sheet.id, ids }
      : { kind: 'sheet', sheetId: sheet.id };
    json(
      ctx.res,
      200,
      await gatherReport({
        scope,
        boardId: board.id,
        boardName: board.name,
        by: await nameOf(userId),
        origin: env.WEB_ORIGIN,
        title: q.get('title') ?? undefined,
      }),
    );
  });

  router.get('/boards/:id/report', async (ctx) => {
    const userId = requireAuth(ctx);
    const board = await boardForViewing(userId, param(ctx, 'id'));
    const q = query(ctx.req.url ?? '');
    const relation = q.get('relation')?.trim();
    const from = q.get('from') ?? '';
    const to = q.get('to') ?? '';
    let scope: ReportScope;
    if (q.has('from') || q.has('to')) {
      if (!UUID.test(from) || !UUID.test(to))
        return json(ctx.res, 400, { error: 'from and to are picture ids' });
      scope = { kind: 'path', boardId: board.id, from, to };
    } else if (relation) {
      scope = { kind: 'relation', boardId: board.id, relation };
    } else {
      scope = { kind: 'board', boardId: board.id };
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
        title: q.get('title') ?? undefined,
      }),
    );
  });
}
