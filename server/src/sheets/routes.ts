import type {
  CreateSheetRequest,
  CreateSheetResponse,
  GetSheetElementsResponse,
  GetSheetForeignResponse,
  GetSheetResponse,
  GetSheetRowsResponse,
  GetStatsResponse,
  ListSheetsResponse,
  SheetImage,
} from '@digsite/shared/api';
import type {
  EdgeRow,
  ForeignEdge,
  ForeignRegion,
  RegionRow,
} from '@digsite/shared/sheet/claims';
// Sheets (CONTEXT.md "Sheet", "Element", "Claim", "Foreign"). See
// docs/design.md "Routes / Sheets".
import {
  type Direction,
  type Properties,
  SHEET_LIMIT,
  fileId,
  imageGroupId,
} from '@digsite/shared/sheet/elements';
import {
  boardForCreatingSheet,
  boardForViewing,
  sheetForEditing,
} from '../access/index.ts';
import { pool } from '../db/pool.ts';
import {
  type Router,
  json,
  param,
  readJsonBody,
  requireAuth,
} from '../http.ts';
import { roomStats } from './room.ts';
import { getSnapshotElements } from './snapshot.ts';

const CELL = 320;
const FIT = 256;

// The regions/edges tables' own (snake_case) shape, as `SELECT *` returns
// it — distinct from shared/sheet/claims.ts's camelCase RegionRow/EdgeRow,
// which is the wire shape.
type RegionDbRow = {
  id: string;
  sheet_id: string;
  source_id: string;
  image_id: string;
  fx: number;
  fy: number;
  fw: number;
  fh: number;
  label: string;
  properties: Properties;
};
type EdgeDbRow = {
  id: string;
  sheet_id: string;
  source_id: string;
  src_image_id: string;
  src_region_source_id: string | null;
  dst_image_id: string;
  dst_region_source_id: string | null;
  direction: string;
  relation: string;
  properties: Properties;
};

function toRegionRow(r: RegionDbRow): RegionRow {
  return {
    id: r.id,
    sheetId: r.sheet_id,
    sourceId: r.source_id,
    imageId: r.image_id,
    fx: r.fx,
    fy: r.fy,
    fw: r.fw,
    fh: r.fh,
    label: r.label,
    properties: r.properties,
  };
}

function toEdgeRow(e: EdgeDbRow): EdgeRow {
  return {
    id: e.id,
    sheetId: e.sheet_id,
    sourceId: e.source_id,
    source: {
      imageId: e.src_image_id,
      ...(e.src_region_source_id
        ? { regionSourceId: e.src_region_source_id }
        : {}),
    },
    target: {
      imageId: e.dst_image_id,
      ...(e.dst_region_source_id
        ? { regionSourceId: e.dst_region_source_id }
        : {}),
    },
    direction: e.direction as Direction,
    relation: e.relation,
    properties: e.properties,
  };
}

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
    const { rows } = await pool.query(
      'SELECT id, name, created_at FROM sheets WHERE board_id = $1 ORDER BY created_at',
      [boardId],
    );
    const response: ListSheetsResponse = rows.map((r) => ({
      id: r.id,
      name: r.name,
      createdAt: r.created_at.toISOString(),
    }));
    json(ctx.res, 200, response);
  });

  router.post('/boards/:id/sheets', async (ctx) => {
    const userId = requireAuth(ctx);
    const boardId = param(ctx, 'id');
    await boardForCreatingSheet(userId, boardId);
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

    const cols = Math.max(1, Math.ceil(Math.sqrt(ordered.length)));
    const elements = ordered.map((img, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const scale = Math.min(FIT / img.width, FIT / img.height, 1);
      const w = img.width * scale;
      const h = img.height * scale;
      const x = col * CELL + (CELL - w) / 2;
      const y = row * CELL + (CELL - h) / 2;
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

    const response: CreateSheetResponse = { id: sheetId };
    json(ctx.res, 200, response);
  });

  router.get('/sheets/:id', async (ctx) => {
    const userId = requireAuth(ctx);
    const sheet = await sheetForEditing(userId, param(ctx, 'id'));
    const { rows } = await pool.query(
      `SELECT i.id, i.slot, i.width, i.height FROM sheet_images si
       JOIN images i ON i.id = si.image_id
       WHERE si.sheet_id = $1 ORDER BY i.slot`,
      [sheet.id],
    );
    const images: SheetImage[] = rows.map((r) => ({
      id: r.id,
      slot: r.slot,
      width: r.width,
      height: r.height,
    }));
    const response: GetSheetResponse = {
      id: sheet.id,
      name: sheet.name,
      boardId: sheet.board_id,
      images,
    };
    json(ctx.res, 200, response);
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
