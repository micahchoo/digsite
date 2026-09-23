import type {
  AddImagesToSheetRequest,
  AddImagesToSheetResponse,
  ArchiveSheetResponse,
  CreateSheetRequest,
  CreateSheetResponse,
  GetNeighbourhoodResponse,
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
import type { ForeignEdge, ForeignRegion } from '@digsite/shared/sheet/claims';
// Sheets (CONTEXT.md "Sheet", "Element", "Claim", "Foreign"). See
// docs/design.md "Routes / Sheets".
import {
  SHEET_LIMIT,
  fileId,
  imageGroupId,
} from '@digsite/shared/sheet/elements';
import {
  boardForCreatingSheet,
  boardForViewing,
  sheetForDeleting,
  sheetForEditing,
} from '../access/index.ts';
import { pool } from '../db/pool.ts';
import { recordActivity } from '../groups/activity.ts';
import {
  type Router,
  json,
  param,
  readJsonBody,
  requireAuth,
} from '../http.ts';
import { neighbourhoodFrom } from './neighbourhood.ts';
import { reachOf } from './reach.ts';
import { broadcastSheetScene, roomStats } from './room.ts';
import { toEdgeRow, toRegionRow } from './rows.ts';
import {
  getSnapshotElements,
  saveSnapshotAndProject,
  saveSnapshotAndProjectInTransaction,
} from './snapshot.ts';

const CELL = 320;
const FIT = 256;

function makeImageElement(
  imageId: string,
  x: number,
  y: number,
  width: number,
  height: number,
  seed: number,
) {
  return {
    id: `el-img-${imageId}`,
    type: 'image',
    x,
    y,
    width,
    height,
    angle: 0,
    strokeColor: 'transparent',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 1,
    strokeStyle: 'solid',
    roughness: 0,
    opacity: 100,
    groupIds: [imageGroupId(imageId)],
    frameId: null,
    roundness: null,
    seed,
    version: 1,
    versionNonce: seed,
    isDeleted: false,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
    status: 'saved',
    fileId: fileId(imageId),
    scale: [1, 1],
    customData: { kind: 'image', imageId },
  };
}

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
    const response: ListSheetsResponse = rows.map((r) => ({
      id: r.id,
      name: r.name,
      createdAt: r.created_at.toISOString(),
      imageCount: Number(r.image_count),
      savedAt: r.saved_at ? r.saved_at.toISOString() : null,
      archived: r.archived,
    }));
    json(ctx.res, 200, response);
  });

  // Sheet from a neighbourhood (docs/phases/2-sheet.md section 4), under
  // boardForViewing — exploring doesn't create anything, so it needs no
  // stronger intent than looking at the board.
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

    const imageIds = body.imageIds.slice(0, SHEET_LIMIT);
    if (imageIds.length === 0) {
      return json(ctx.res, 400, { error: 'no images' });
    }

    const { rows: imageRows } = await pool.query(
      'SELECT id, width, height FROM images WHERE board_id = $1 AND id = ANY($2::uuid[])',
      [boardId, imageIds],
    );
    const byId = new Map(imageRows.map((r) => [r.id, r]));
    const ordered = imageIds
      .map((id) => byId.get(id))
      .filter((r): r is NonNullable<typeof r> => !!r);
    if (ordered.length === 0) {
      return json(ctx.res, 400, { error: 'no images on this board' });
    }

    // Phase 2 section 4: an explicit centre (e.g. shared/sheet/layout.ts's
    // ringLayout, sent by the client) wins per-image; anything else falls
    // back to the grid this route has always used. Only x/y come from
    // `positions` — width/height are still the image's own, fit-scaled.
    const cols = Math.max(1, Math.ceil(Math.sqrt(ordered.length)));
    const elements = ordered.map((img, i) => {
      const scale = Math.min(FIT / img.width, FIT / img.height, 1);
      const w = img.width * scale;
      const h = img.height * scale;
      const centre = body.positions?.[img.id];
      let x: number;
      let y: number;
      if (centre) {
        x = centre.x - w / 2;
        y = centre.y - h / 2;
      } else {
        const col = i % cols;
        const row = Math.floor(i / cols);
        x = col * CELL + (CELL - w) / 2;
        y = row * CELL + (CELL - h) / 2;
      }
      return makeImageElement(img.id, x, y, w, h, i + 1);
    });

    const client = await pool.connect();
    let sheetId: string;
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        'INSERT INTO sheets (board_id, name, created_by) VALUES ($1,$2,$3) RETURNING id',
        [boardId, body.name, userId],
      );
      sheetId = rows[0].id;
      for (const img of ordered) {
        await client.query(
          'INSERT INTO sheet_images (sheet_id, image_id) VALUES ($1,$2)',
          [sheetId, img.id],
        );
      }
      await client.query(
        'INSERT INTO sheet_snapshots (sheet_id, elements, saved_at) VALUES ($1,$2,now())',
        [sheetId, JSON.stringify(elements)],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

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
    const requested = body.imageIds;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const lockedSheet = await client.query(
        'SELECT id FROM sheets WHERE id = $1 FOR UPDATE',
        [sheet.id],
      );
      if (lockedSheet.rows.length === 0) {
        await client.query('ROLLBACK');
        return json(ctx.res, 404, { reason: 'sheet not found' });
      }
      const { rows: existingRows } = await client.query(
        'SELECT image_id FROM sheet_images WHERE sheet_id = $1',
        [sheet.id],
      );
      const already = new Set(existingRows.map((r) => r.image_id as string));
      const existingCount = already.size;

      // Dedupe the request itself, preserving first-seen order; anything
      // already on the sheet is skipped (reported once even if repeated in
      // the request).
      const seen = new Set<string>();
      const wanted: string[] = [];
      const skipped: string[] = [];
      for (const id of requested) {
        if (seen.has(id)) continue;
        seen.add(id);
        if (already.has(id)) skipped.push(id);
        else wanted.push(id);
      }

      let ordered: { id: string; width: number; height: number }[] = [];
      if (wanted.length > 0) {
        const { rows: imageRows } = await client.query(
          'SELECT id, width, height FROM images WHERE board_id = $1 AND id = ANY($2::uuid[])',
          [boardId, wanted],
        );
        const byId = new Map(imageRows.map((r) => [r.id, r]));
        ordered = wanted
          .map((id) => byId.get(id))
          .filter((r): r is NonNullable<typeof r> => !!r);
        const notOnBoard = wanted.filter((id) => !byId.has(id));
        skipped.push(...notOnBoard);
      }

      // Cap at SHEET_LIMIT total, same cap sheet creation itself uses
      // (shared/sheet/elements.ts) — the over-cap ones are skipped, not
      // refused outright (docs/ux/design.md §5.1 "no action is ever refused
      // outright").
      const room = Math.max(0, SHEET_LIMIT - existingCount);
      const toAdd = ordered.slice(0, room);
      skipped.push(...ordered.slice(room).map((r) => r.id));

      if (toAdd.length === 0) {
        await client.query('COMMIT');
        const response: AddImagesToSheetResponse = { added: [], skipped };
        return json(ctx.res, 200, response);
      }

      // Bounding box of the existing content, from the CURRENT snapshot
      // (foreign-never-in-scene.md's own discipline, applied here: act on
      // polled/stored state, rebased at write time, never a stale cache) —
      // own image elements only (customData.kind === 'image'); a sheet
      // holding no images yet starts the grid at the origin.
      const { rows: snapshotRows } = await client.query(
        'SELECT elements FROM sheet_snapshots WHERE sheet_id = $1',
        [sheet.id],
      );
      const stored = (snapshotRows.length ? snapshotRows[0].elements : []) as {
        x: number;
        y: number;
        width: number;
        height: number;
        customData?: { kind?: string };
      }[];
      const ownImages = stored.filter((e) => e.customData?.kind === 'image');
      const maxX = ownImages.reduce((m, e) => Math.max(m, e.x + e.width), 0);
      const minY = ownImages.length
        ? Math.min(...ownImages.map((e) => e.y))
        : 0;
      const startX = ownImages.length ? maxX + CELL : 0;

      const cols = Math.max(1, Math.ceil(Math.sqrt(toAdd.length)));
      const newElements = toAdd.map((img, i) => {
        const scale = Math.min(FIT / img.width, FIT / img.height, 1);
        const w = img.width * scale;
        const h = img.height * scale;
        const col = i % cols;
        const row = Math.floor(i / cols);
        const x = startX + col * CELL + (CELL - w) / 2;
        const y = minY + row * CELL + (CELL - h) / 2;
        return makeImageElement(img.id, x, y, w, h, i + 1);
      });

      for (const img of toAdd) {
        await client.query(
          'INSERT INTO sheet_images (sheet_id, image_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [sheet.id, img.id],
        );
      }
      const saved = await saveSnapshotAndProjectInTransaction(
        client,
        sheet.id,
        newElements,
      );
      await client.query('COMMIT');

      // The snapshot is committed before the room sees the same full merged
      // scene. Clients and the later room debounce use the normal version
      // merge path, so a stale peer scene cannot remove these additions.
      broadcastSheetScene(sheet.id, saved.elements, userId);

      const response: AddImagesToSheetResponse = {
        added: toAdd.map((img) => img.id),
        skipped,
      };
      json(ctx.res, 200, response);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  // GET /sheets/:id/footprint (docs/phases/3-groups.md section 4): how many
  // OTHER sheets hold an image carrying a claim (region or edge) this sheet
  // made — the delete confirmation's count. A claim counts as held the same
  // way GET /sheets/:id/foreign does: a region by its image, an edge by
  // BOTH endpoint images.
  router.get('/sheets/:id/footprint', async (ctx) => {
    const userId = requireAuth(ctx);
    const sheet = await sheetForDeleting(userId, param(ctx, 'id'));
    const { rows } = await pool.query(
      `SELECT COUNT(DISTINCT other_sheet) AS count FROM (
         SELECT r.sheet_id AS other_sheet FROM regions r
         WHERE r.sheet_id != $1
           AND r.image_id IN (SELECT image_id FROM sheet_images WHERE sheet_id = $1)
         UNION
         SELECT e.sheet_id AS other_sheet FROM edges e
         WHERE e.sheet_id != $1
           AND e.src_image_id IN (SELECT image_id FROM sheet_images WHERE sheet_id = $1)
           AND e.dst_image_id IN (SELECT image_id FROM sheet_images WHERE sheet_id = $1)
       ) other_sheets`,
      [sheet.id],
    );
    const response: SheetFootprint = { foreignViews: Number(rows[0].count) };
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
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM edges WHERE sheet_id = $1', [sheet.id]);
      await client.query('DELETE FROM regions WHERE sheet_id = $1', [sheet.id]);
      await client.query('DELETE FROM sheet_snapshots WHERE sheet_id = $1', [
        sheet.id,
      ]);
      await client.query('DELETE FROM sheet_reads WHERE sheet_id = $1', [
        sheet.id,
      ]);
      await client.query('DELETE FROM sheet_images WHERE sheet_id = $1', [
        sheet.id,
      ]);
      await client.query('DELETE FROM sheets WHERE id = $1', [sheet.id]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
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

    const { rows: regionRows } = await pool.query(
      `SELECT r.*, s.name AS sheet_name FROM regions r
       JOIN sheets s ON s.id = r.sheet_id
       WHERE r.sheet_id != $1
         AND r.image_id IN (SELECT image_id FROM sheet_images WHERE sheet_id = $1)`,
      [sheet.id],
    );
    const { rows: edgeRows } = await pool.query(
      `SELECT e.*, s.name AS sheet_name FROM edges e
       JOIN sheets s ON s.id = e.sheet_id
       WHERE e.sheet_id != $1
         AND e.src_image_id IN (SELECT image_id FROM sheet_images WHERE sheet_id = $1)
         AND e.dst_image_id IN (SELECT image_id FROM sheet_images WHERE sheet_id = $1)`,
      [sheet.id],
    );

    const regions: ForeignRegion[] = regionRows.map((r) => ({
      ...toRegionRow(r),
      sheetName: r.sheet_name,
    }));
    const edges: ForeignEdge[] = edgeRows.map((e) => ({
      ...toEdgeRow(e),
      sheetName: e.sheet_name,
    }));
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
