import type {
  AddImagesToSheetRequest,
  AddImagesToSheetResponse,
  AddReplyRequest,
  AddReplyResponse,
  ArchiveSheetResponse,
  CreateSheetRequest,
  CreateSheetResponse,
  GetNeighbourhoodResponse,
  GetRepliesResponse,
  GetSheetElementsResponse,
  GetSheetForeignResponse,
  GetSheetReachResponse,
  GetSheetResponse,
  GetSheetRowsResponse,
  GetStatsResponse,
  ListSheetsResponse,
  MarkSheetSeenResponse,
  SheetFootprint,
  SheetImage,
  UpdateSheetRequest,
  UpdateSheetResponse,
} from '@digsite/shared/api';
// Sheets (CONTEXT.md "Sheet", "Element", "Claim", "Foreign"). See
// docs/design.md "Routes / Sheets".
import {
  boardForCreatingSheet,
  boardForViewing,
  sheetForDeleting,
  sheetForDiscussing,
  sheetForEditing,
} from '../access/index.ts';
import { removeSheet } from '../boards/removal.ts';
import { pool } from '../db/pool.ts';
import { recordActivity } from '../groups/activity.ts';
import {
  type Router,
  json,
  param,
  readJsonBody,
  requireAuth,
} from '../http.ts';
import { foreignOn, sheetsShowing } from './foreign.ts';
import { addImages, createSheet } from './membership.ts';
import { boardWeb, neighbourhoodFrom } from './neighbourhood.ts';
import { participantsOf } from './participants.ts';
import { reachOf } from './reach.ts';
import {
  REPLY_MAX_CHARS,
  addReply,
  removeReply,
  repliesOn,
} from './replies.ts';
import { broadcastSheetScene, roomStats } from './room.ts';
import { toEdgeRow, toRegionRow } from './rows.ts';
import { getSnapshotElements, saveSnapshotAndProject } from './snapshot.ts';

export function registerSheetRoutes(router: Router) {
  router.get('/boards/:id/sheets', async (ctx) => {
    const userId = requireAuth(ctx);
    const boardId = param(ctx, 'id');
    await boardForViewing(userId, boardId);
    // imageCount/savedAt (docs/phases/2-sheet.md section 6): a sheet with
    // no snapshot yet (never through the socket room, never `POST .../sheets`
    // by hand) has no sheet_snapshots row, hence the LEFT JOIN and a null
    // savedAt rather than a missing one.
    //
    // docs/phases/6-product.md "Sheets are threads": archived sheets are
    // excluded unless `?archived=1` — the thread browser's own "Show"
    // toggle (docs/ux/design.md §4.8).
    const includeArchived = ctx.url.searchParams.get('archived') === '1';
    const { rows } = await pool.query(
      `SELECT s.id, s.name, s.created_at, s.archived, ss.saved_at,
         (SELECT COUNT(*) FROM sheet_images si WHERE si.sheet_id = s.id) AS image_count
       FROM sheets s
       LEFT JOIN sheet_snapshots ss ON ss.sheet_id = s.id
       WHERE s.board_id = $1 AND ($2::boolean OR s.archived = false)
       ORDER BY s.created_at`,
      [boardId, includeArchived],
    );
    const people = await participantsOf(rows.map((r) => r.id));
    const response: ListSheetsResponse = rows.map((r) => ({
      id: r.id,
      name: r.name,
      createdAt: r.created_at.toISOString(),
      participants: people.get(r.id) ?? [],
      imageCount: Number(r.image_count),
      savedAt: r.saved_at ? r.saved_at.toISOString() : null,
      archived: r.archived,
    }));
    json(ctx.res, 200, response);
  });

  // Sheet from a neighbourhood (docs/phases/2-sheet.md section 4), under
  // boardForViewing — exploring doesn't create anything, so it needs no
  // stronger intent than looking at the board.
  // GET /boards/:id/relation-web?relation= (roadmap horizon 3): every
  // connection meaning that relation across the board's sheets, and the
  // pictures it joins; the neighbourhood's shape, every hop 0. With no
  // relation, every connection: the board's whole web.
  router.get('/boards/:id/relation-web', async (ctx) => {
    const userId = requireAuth(ctx);
    const boardId = param(ctx, 'id');
    await boardForViewing(userId, boardId);
    const relation = (ctx.url.searchParams.get('relation') ?? '').trim();
    if (relation.length > 200) {
      return json(ctx.res, 400, {
        error: 'relation is at most 200 characters',
      });
    }
    const response: GetNeighbourhoodResponse = await boardWeb(
      boardId,
      relation || null,
    );
    json(ctx.res, 200, response);
  });

  router.get('/boards/:id/neighbourhood', async (ctx) => {
    const userId = requireAuth(ctx);
    const boardId = param(ctx, 'id');
    await boardForViewing(userId, boardId);

    const from = ctx.url.searchParams.get('from');
    if (!from) return json(ctx.res, 400, { error: 'from required' });
    const hops = Number(ctx.url.searchParams.get('hops'));
    if (!Number.isInteger(hops) || hops < 1 || hops > 3) {
      return json(ctx.res, 400, { error: 'hops must be an integer 1..3' });
    }
    const relation = ctx.url.searchParams.get('relation') || undefined;

    const { rows: fromRows } = await pool.query(
      'SELECT 1 FROM images WHERE id = $1 AND board_id = $2',
      [from, boardId],
    );
    if (fromRows.length === 0) {
      return json(ctx.res, 400, {
        error: 'from is not an image on this board',
      });
    }

    const response: GetNeighbourhoodResponse = await neighbourhoodFrom(
      boardId,
      from,
      hops,
      relation,
    );
    json(ctx.res, 200, response);
  });

  router.post('/boards/:id/sheets', async (ctx) => {
    const userId = requireAuth(ctx);
    const boardId = param(ctx, 'id');
    const board = await boardForCreatingSheet(userId, boardId);
    const body = (await readJsonBody(ctx.req)) as CreateSheetRequest;

    if (
      !Array.isArray(body.imageIds) ||
      !body.imageIds.every((id) => typeof id === 'string') ||
      typeof body.name !== 'string'
    ) {
      return json(ctx.res, 400, {
        error: 'a sheet takes a name and imageIds',
      });
    }
    if (body.imageIds.length === 0) {
      return json(ctx.res, 400, { error: 'no images' });
    }
    // Phase 2 section 4: an explicit centre (shared/sheet/layout.ts's
    // ringLayout, sent by the client) wins per picture (layout.ts).
    const made = await createSheet(
      boardId,
      body.name,
      body.imageIds,
      userId,
      body.positions,
    );
    if (!made) {
      return json(ctx.res, 400, { error: 'no images on this board' });
    }
    const sheetId = made.id;

    // docs/phases/6-product.md "Group activity feed": "sheet started" —
    // best-effort, never fails sheet creation itself.
    try {
      await recordActivity(board.org_id, boardId, 'sheet_started', userId, {
        sheetName: body.name,
      });
    } catch {
      // best-effort — the sheet is already committed regardless.
    }

    const response: CreateSheetResponse = { id: sheetId };
    json(ctx.res, 200, response);
  });

  router.get('/sheets/:id', async (ctx) => {
    const userId = requireAuth(ctx);
    const sheet = await sheetForEditing(userId, param(ctx, 'id'));
    // name/missing (docs/phases/3-groups.md section 4): so the sheet can
    // show a name and skip fetching a deleted original.
    const { rows } = await pool.query(
      `SELECT i.id, i.slot, i.width, i.height, i.name, i.missing FROM sheet_images si
       JOIN images i ON i.id = si.image_id
       WHERE si.sheet_id = $1 ORDER BY i.slot`,
      [sheet.id],
    );
    const images: SheetImage[] = rows.map((r) => ({
      id: r.id,
      slot: r.slot,
      width: r.width,
      height: r.height,
      name: r.name,
      missing: r.missing,
    }));
    const { rows: snapRows } = await pool.query(
      'SELECT saved_at FROM sheet_snapshots WHERE sheet_id = $1',
      [sheet.id],
    );
    const response: GetSheetResponse = {
      id: sheet.id,
      name: sheet.name,
      boardId: sheet.board_id,
      images,
      savedAt: snapRows[0]?.saved_at
        ? snapRows[0].saved_at.toISOString()
        : null,
    };
    json(ctx.res, 200, response);
  });

  router.patch('/sheets/:id', async (ctx) => {
    const userId = requireAuth(ctx);
    const sheet = await sheetForEditing(userId, param(ctx, 'id'));
    const body = (await readJsonBody(ctx.req)) as UpdateSheetRequest;
    const name = body.name?.trim();
    if (!name) return json(ctx.res, 400, { error: 'name required' });
    await pool.query('UPDATE sheets SET name = $1 WHERE id = $2', [
      name,
      sheet.id,
    ]);
    const response: UpdateSheetResponse = { name };
    json(ctx.res, 200, response);
  });

  // POST /sheets/:id/seen (docs/phases/6-product.md "Sheets are threads"):
  // last-seen per user per sheet, server-side so unread survives devices.
  // sheetForEditing, same intent as opening the sheet at all — marking it
  // seen needs no stronger permission than that.
  router.post('/sheets/:id/seen', async (ctx) => {
    const userId = requireAuth(ctx);
    const sheet = await sheetForEditing(userId, param(ctx, 'id'));
    const { rows } = await pool.query(
      `INSERT INTO sheet_reads (user_id, sheet_id, seen_at)
       VALUES ($1, $2, now())
       ON CONFLICT (user_id, sheet_id) DO UPDATE SET seen_at = now()
       RETURNING seen_at`,
      [userId, sheet.id],
    );
    const response: MarkSheetSeenResponse = {
      seenAt: rows[0].seen_at.toISOString(),
    };
    json(ctx.res, 200, response);
  });

  // POST /sheets/:id/archive, POST /sheets/:id/unarchive
  // (docs/phases/6-product.md "Sheets are threads"): hidden from
  // GET /boards/:id/sheets by default, kept, reopenable — never a delete.
  // Any viewer of the parent board may archive or reopen it, as specified;
  // this is discoverability state, not deletion.
  router.post('/sheets/:id/archive', async (ctx) => {
    const userId = requireAuth(ctx);
    const sheet = await sheetForEditing(userId, param(ctx, 'id'));
    await pool.query('UPDATE sheets SET archived = true WHERE id = $1', [
      sheet.id,
    ]);
    const response: ArchiveSheetResponse = { archived: true };
    json(ctx.res, 200, response);
  });
  router.post('/sheets/:id/unarchive', async (ctx) => {
    const userId = requireAuth(ctx);
    const sheet = await sheetForEditing(userId, param(ctx, 'id'));
    await pool.query('UPDATE sheets SET archived = false WHERE id = $1', [
      sheet.id,
    ]);
    const response: ArchiveSheetResponse = { archived: false };
    json(ctx.res, 200, response);
  });

  // POST /boards/:id/sheets/:sheetId/images (docs/phases/6-product.md
  // "Selection... Add to sheet…"): adds only images not already on the
  // sheet, placed to the right of the existing content's bounding box,
  // grid-wrapped, then snapshot + projection as usual
  // (snapshot.ts#saveSnapshotAndProject — the same merge-by-version path a
  // live socket save goes through). sheetForEditing is the one access
  // function; the boardId in the path is checked against the sheet's own
  // board_id for a 404 (not a second access decision) rather than trusted.
  router.post('/boards/:id/sheets/:sheetId/images', async (ctx) => {
    const userId = requireAuth(ctx);
    const boardId = param(ctx, 'id');
    const sheetId = param(ctx, 'sheetId');
    const sheet = await sheetForEditing(userId, sheetId);
    if (sheet.board_id !== boardId) {
      return json(ctx.res, 404, { reason: 'sheet not found on this board' });
    }
    const body = (await readJsonBody(ctx.req)) as AddImagesToSheetRequest;
    if (
      !Array.isArray(body.imageIds) ||
      !body.imageIds.every(
        (imageId) =>
          typeof imageId === 'string' &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            imageId,
          ),
      )
    ) {
      return json(ctx.res, 400, { error: 'imageIds must be an array of ids' });
    }
    const result = await addImages(sheet.id, boardId, body.imageIds);
    if (!result) return json(ctx.res, 404, { reason: 'sheet not found' });
    // Committed before the room sees the whole merged scene, so a stale
    // peer scene cannot remove the additions (the version merge).
    if (result.scene) broadcastSheetScene(sheet.id, result.scene, userId);
    const response: AddImagesToSheetResponse = {
      added: result.added,
      skipped: result.skipped,
    };
    json(ctx.res, 200, response);
  });

  // GET /sheets/:id/footprint (docs/phases/3-groups.md section 4): how many
  // other sheets show a claim this sheet made, the delete confirmation's
  // count (foreign.ts#sheetsShowing).
  router.get('/sheets/:id/footprint', async (ctx) => {
    const userId = requireAuth(ctx);
    const sheet = await sheetForDeleting(userId, param(ctx, 'id'));
    const response: SheetFootprint = {
      foreignViews: await sheetsShowing(sheet.id),
    };
    json(ctx.res, 200, response);
  });

  // DELETE /sheets/:id (docs/phases/3-groups.md section 4): the snapshot and
  // this sheet's own rows. Claims other sheets saw as foreign simply vanish
  // from their next poll (GET /sheets/:id/foreign already filters by
  // `sheet_id != $1` against live rows); their own copies (made via
  // copyForeign, ordinary own regions from the moment they exist — see
  // .claude/rules/foreign-never-in-scene.md) stay untouched.
  router.del('/sheets/:id', async (ctx) => {
    const userId = requireAuth(ctx);
    const sheet = await sheetForDeleting(userId, param(ctx, 'id'));
    await removeSheet(sheet.id);
    json(ctx.res, 200, {});
  });

  router.get('/sheets/:id/elements', async (ctx) => {
    const userId = requireAuth(ctx);
    const sheet = await sheetForEditing(userId, param(ctx, 'id'));
    const elements = await getSnapshotElements(sheet.id);
    const response: GetSheetElementsResponse = { elements };
    json(ctx.res, 200, response);
  });

  router.get('/sheets/:id/foreign', async (ctx) => {
    const userId = requireAuth(ctx);
    const sheet = await sheetForEditing(userId, param(ctx, 'id'));

    const { regions, edges } = await foreignOn(sheet.id);
    const response: GetSheetForeignResponse = { regions, edges };
    json(ctx.res, 200, response);
  });

  // GET /sheets/:id/reach (CONTEXT.md "Reach"): other sheets' edges with
  // exactly one end on this sheet — where this sheet's images lead that the
  // sheet does not show — and the far images, enough to preview and bring
  // them in. The overlay draws these; they never enter the scene
  // (.claude/rules/foreign-never-in-scene.md). Bounded: the nearest
  // REACH_LIMIT edges are plenty to show and the payload stays small.
  // GET /sheets/:id/reach (CONTEXT.md "Reach"): see reach.ts.
  router.get('/sheets/:id/reach', async (ctx) => {
    const userId = requireAuth(ctx);
    const sheet = await sheetForEditing(userId, param(ctx, 'id'));
    const response: GetSheetReachResponse = await reachOf(
      sheet.id,
      sheet.board_id,
    );
    json(ctx.res, 200, response);
  });

  // CONTEXT.md "Reply": what people say about a claim (replies.ts). Anyone
  // who can see the board may read and add; only the writer removes.
  router.get('/sheets/:id/replies', async (ctx) => {
    const userId = requireAuth(ctx);
    const sheet = await sheetForDiscussing(userId, param(ctx, 'id'));
    const response: GetRepliesResponse = { replies: await repliesOn(sheet.id) };
    json(ctx.res, 200, response);
  });

  router.post('/sheets/:id/replies', async (ctx) => {
    const userId = requireAuth(ctx);
    const sheet = await sheetForDiscussing(userId, param(ctx, 'id'));
    const body = (await readJsonBody(ctx.req)) as Partial<AddReplyRequest>;
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    const elementId =
      typeof body?.elementId === 'string' ? body.elementId.trim() : '';
    if (!elementId || elementId.length > 200) {
      return json(ctx.res, 400, { error: 'elementId is required' });
    }
    if (!text || text.length > REPLY_MAX_CHARS) {
      return json(ctx.res, 400, {
        error: `a reply is 1 to ${REPLY_MAX_CHARS} characters`,
      });
    }
    const response: AddReplyResponse = await addReply(
      sheet.board_id,
      sheet.id,
      elementId,
      userId,
      text,
    );
    json(ctx.res, 201, response);
  });

  router.del('/sheets/:id/replies/:replyId', async (ctx) => {
    const userId = requireAuth(ctx);
    const sheet = await sheetForDiscussing(userId, param(ctx, 'id'));
    const removed = await removeReply(sheet.id, param(ctx, 'replyId'), userId);
    if (!removed) {
      return json(ctx.res, 403, { reason: 'only its writer removes a reply' });
    }
    json(ctx.res, 200, { ok: true });
  });

  router.get('/sheets/:id/rows', async (ctx) => {
    const userId = requireAuth(ctx);
    const sheet = await sheetForEditing(userId, param(ctx, 'id'));
    const { rows: regionRows } = await pool.query(
      'SELECT * FROM regions WHERE sheet_id = $1',
      [sheet.id],
    );
    const { rows: edgeRows } = await pool.query(
      'SELECT * FROM edges WHERE sheet_id = $1',
      [sheet.id],
    );
    const response: GetSheetRowsResponse = {
      regions: regionRows.map(toRegionRow),
      edges: edgeRows.map(toEdgeRow),
    };
    json(ctx.res, 200, response);
  });

  router.get('/stats', async (ctx) => {
    requireAuth(ctx);
    const response: GetStatsResponse = { ...roomStats };
    json(ctx.res, 200, response);
  });
}
