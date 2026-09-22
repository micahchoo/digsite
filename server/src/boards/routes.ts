// Boards (CONTEXT.md "Board", "Image", "Tile"). See docs/design.md
// "Routes / Boards" for the fixed route shapes.
import { readFileSync } from 'node:fs';
import type {
  AllowlistRequest,
  AllowlistResponse,
  BoardImage,
  BoardSummary,
  CreateBoardRequest,
  CreateBoardResponse,
  GetBoardResponse,
  GetImageResponse,
  GetSectionsResponse,
  ListBoardImagesResponse,
  ListBoardsResponse,
  RebuildSortResponse,
  SortableKey,
  UpdateBoardRequest,
  UpdateBoardResponse,
  UpdateImagePropertiesRequest,
  UpdateImagePropertiesResponse,
  UploadImagesResponse,
} from '@digsite/shared/api';
import { ZOOMS, type Zoom, cellPx } from '@digsite/shared/board/grid';
import {
  type PropertyType,
  type Sort,
  parseSortId,
} from '@digsite/shared/board/sort';
import { fromNodeHeaders } from 'better-auth/node';
import {
  type BoardRow,
  type ImageRow,
  boardForCreating,
  boardForManagingAllowlist,
  boardForUploading,
  boardForViewing,
  boardsForListing,
  imageForViewing,
} from '../access/index.ts';
import { auth } from '../auth.ts';
import { pool } from '../db/pool.ts';
import {
  type Router,
  json,
  param,
  readJsonBody,
  requireAuth,
  toWebRequest,
} from '../http.ts';
import { enqueueMaterialiseJob } from '../worker/jobs.ts';
import { originalPath } from './paths.ts';
import { forceRebuildRank, imagesInRankOrder } from './ranks.ts';
import { sectionsFor } from './sections.ts';
import { tileFor } from './tiles.ts';
import { uploadOne } from './upload.ts';

function toBoardSummary(b: BoardRow): BoardSummary {
  return { id: b.id, name: b.name, open: b.open, imageCount: b.image_count };
}

function toBoardImage(i: ImageRow): BoardImage {
  return {
    id: i.id,
    slot: i.slot,
    name: i.name,
    width: i.width,
    height: i.height,
    uploadedAt: i.uploaded_at.toISOString(),
    properties: i.properties as BoardImage['properties'],
    missing: i.missing,
    status: i.status,
    error: i.error,
  };
}

async function sortableKeysFor(boardId: string): Promise<SortableKey[]> {
  const keys: SortableKey[] = [
    { key: 'name', label: 'Name' },
    { key: 'uploaded_at', label: 'Uploaded' },
  ];
  const { rows } = await pool.query(
    `SELECT e.key, jsonb_typeof(e.value) AS t
     FROM images i, jsonb_each(i.properties) e
     WHERE i.board_id = $1`,
    [boardId],
  );
  const typesByKey = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!typesByKey.has(r.key)) typesByKey.set(r.key, new Set());
    typesByKey.get(r.key)?.add(r.t);
  }
  for (const [propKey, types] of typesByKey) {
    if (types.size !== 1) continue; // mixed types: not sortable
    const jsonType = [...types][0];
    const type: PropertyType | null =
      jsonType === 'string'
        ? 'text'
        : jsonType === 'number'
          ? 'number'
          : jsonType === 'boolean'
            ? 'boolean'
            : null;
    if (!type) continue;
    keys.push({ key: { property: propKey, type }, label: propKey });
  }
  return keys;
}

function parseSortOrDefault(id: string | null): Sort {
  if (!id) return { key: 'uploaded_at', dir: 'desc' };
  const parsed = parseSortId(id);
  return parsed ?? { key: 'uploaded_at', dir: 'desc' };
}

export function registerBoardRoutes(router: Router) {
  router.get('/groups/:id/boards', async (ctx) => {
    const userId = requireAuth(ctx);
    const boards = await boardsForListing(userId, param(ctx, 'id'));
    const response: ListBoardsResponse = boards.map(toBoardSummary);
    json(ctx.res, 200, response);
  });

  router.post('/groups/:id/boards', async (ctx) => {
    const userId = requireAuth(ctx);
    const orgId = param(ctx, 'id');
    await boardForCreating(userId, orgId);
    const body = (await readJsonBody(ctx.req)) as CreateBoardRequest;

    let teamId: string | null = null;
    if (!body.open) {
      const team = await auth.api.createTeam({
        body: {
          name: `allowlist-${body.name}-${Date.now()}`,
          organizationId: orgId,
        },
        headers: fromNodeHeaders(ctx.req.headers),
      });
      teamId = team?.id;
      await auth.api.addTeamMember({
        body: { teamId, userId, organizationId: orgId },
        headers: fromNodeHeaders(ctx.req.headers),
      });
    }

    const { rows } = await pool.query(
      `INSERT INTO boards (org_id, name, open, team_id, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [orgId, body.name, !!body.open, teamId, userId],
    );
    const response: CreateBoardResponse = { id: rows[0].id };
    json(ctx.res, 200, response);
  });

  router.get('/boards/:id', async (ctx) => {
    const userId = requireAuth(ctx);
    const boardId = param(ctx, 'id');
    const board = await boardForViewing(userId, boardId);
    const sortableKeys = await sortableKeysFor(boardId);
    const response: GetBoardResponse = {
      id: board.id,
      name: board.name,
      open: board.open,
      imageCount: board.image_count,
      defaultSort: board.default_sort,
      sortableKeys,
    };
    json(ctx.res, 200, response);
  });

  router.patch('/boards/:id', async (ctx) => {
    const userId = requireAuth(ctx);
    const boardId = param(ctx, 'id');
    await boardForManagingAllowlist(userId, boardId);
    const body = (await readJsonBody(ctx.req)) as UpdateBoardRequest;
    if (!parseSortId(body.defaultSort)) {
      return json(ctx.res, 400, { error: 'bad sort id' });
    }
    await pool.query('UPDATE boards SET default_sort = $1 WHERE id = $2', [
      body.defaultSort,
      boardId,
    ]);
    const response: UpdateBoardResponse = { defaultSort: body.defaultSort };
    json(ctx.res, 200, response);
  });

  router.post('/boards/:id/allowlist', async (ctx) => {
    const userId = requireAuth(ctx);
    const boardId = param(ctx, 'id');
    const board = await boardForManagingAllowlist(userId, boardId);
    if (!board.team_id)
      return json(ctx.res, 400, { error: 'board has no allowlist' });
    const body = (await readJsonBody(ctx.req)) as AllowlistRequest;
    await auth.api.addTeamMember({
      body: {
        teamId: board.team_id,
        userId: body.userId,
        organizationId: board.org_id,
      },
      headers: fromNodeHeaders(ctx.req.headers),
    });
    const { rows } = await pool.query(
      `SELECT "userId" FROM "teamMember" WHERE "teamId" = $1 ORDER BY "createdAt"`,
      [board.team_id],
    );
    const response: AllowlistResponse = rows.map((r) => ({ userId: r.userId }));
    json(ctx.res, 200, response);
  });

  router.del('/boards/:id/allowlist/:userId', async (ctx) => {
    const userId = requireAuth(ctx);
    const boardId = param(ctx, 'id');
    const targetUserId = param(ctx, 'userId');
    const board = await boardForManagingAllowlist(userId, boardId);
    if (!board.team_id)
      return json(ctx.res, 400, { error: 'board has no allowlist' });
    await auth.api.removeTeamMember({
      body: {
        teamId: board.team_id,
        userId: targetUserId,
        organizationId: board.org_id,
      },
      headers: fromNodeHeaders(ctx.req.headers),
    });
    const { rows } = await pool.query(
      `SELECT "userId" FROM "teamMember" WHERE "teamId" = $1 ORDER BY "createdAt"`,
      [board.team_id],
    );
    const response: AllowlistResponse = rows.map((r) => ({ userId: r.userId }));
    json(ctx.res, 200, response);
  });

  router.post('/boards/:id/images', async (ctx) => {
    const userId = requireAuth(ctx);
    const boardId = param(ctx, 'id');
    await boardForUploading(userId, boardId);

    const webReq = await toWebRequest(ctx.req);
    const form = await webReq.formData();
    const files: File[] = [];
    for (const entry of form.getAll('files')) {
      if (typeof entry !== 'string') files.push(entry);
    }
    if (files.length === 0) {
      return json(ctx.res, 400, { error: 'no files' });
    }
    // One JSON field "properties": an array of per-file property objects,
    // same order as "files". Optional; a plain upload has none, and the
    // simplest way to set them is PATCH /images/:id afterwards (seed.ts
    // does this — see server/README.md).
    let propsArray: Record<string, unknown>[] = [];
    const propsField = form.get('properties');
    if (typeof propsField === 'string') {
      try {
        const parsed = JSON.parse(propsField);
        if (Array.isArray(parsed)) propsArray = parsed;
      } catch {
        // ignored — properties stay empty for every file
      }
    }

    const out: UploadImagesResponse = [];
    const ids: string[] = [];
    for (const [i, file] of files.entries()) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const properties = propsArray[i] ?? {};
      const uploaded = await uploadOne(
        boardId,
        userId,
        file.name || `upload-${Date.now()}`,
        bytes,
        properties,
      );
      ids.push(uploaded.id);
      out.push(uploaded);
    }

    // docs/phases/1-map.md: the multipart route waits (up to 10s) for the
    // images it just enqueued to leave `pending`, so a caller that uploads
    // and immediately requests a tile sees them painted (e2e scenario 3).
    // `?wait=0` skips this and returns the `pending` rows straight away.
    // tus uploads (boards/tus.ts) never wait — see server/README.md.
    const wait = ctx.url.searchParams.get('wait') !== '0';
    if (wait && ids.length > 0) {
      const deadline = Date.now() + 10_000;
      let statuses = new Map<string, string>();
      for (;;) {
        const { rows } = await pool.query(
          'SELECT id, status FROM images WHERE id = ANY($1::uuid[])',
          [ids],
        );
        statuses = new Map(rows.map((r) => [r.id, r.status]));
        const settled = ids.every((id) => statuses.get(id) !== 'pending');
        if (settled || Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      for (const item of out) {
        const s = statuses.get(item.id);
        if (s === 'ready' || s === 'pending' || s === 'failed') {
          item.status = s;
        }
      }
    }

    json(ctx.res, 202, out);
  });

  router.get('/boards/:id/images', async (ctx) => {
    const userId = requireAuth(ctx);
    const boardId = param(ctx, 'id');
    await boardForViewing(userId, boardId);
    const sort = parseSortOrDefault(ctx.url.searchParams.get('sort'));
    const from = Number(ctx.url.searchParams.get('from') ?? '0');
    const count = Math.min(
      Number(ctx.url.searchParams.get('count') ?? '50'),
      500,
    );
    const ranked = await imagesInRankOrder(boardId, sort, from, count);
    const ids = ranked.map((r) => r.imageId);
    if (ids.length === 0) {
      const response: ListBoardImagesResponse = { images: [] };
      return json(ctx.res, 200, response);
    }
    const { rows } = await pool.query(
      'SELECT * FROM images WHERE id = ANY($1::uuid[])',
      [ids],
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    const images = ranked
      .map((r) => byId.get(r.imageId))
      .filter((r): r is NonNullable<typeof r> => !!r)
      .map(toBoardImage);
    const response: ListBoardImagesResponse = { images };
    json(ctx.res, 200, response);
  });

  router.get('/images/:id', async (ctx) => {
    const userId = requireAuth(ctx);
    const image = await imageForViewing(userId, param(ctx, 'id'));
    const response: GetImageResponse = {
      ...toBoardImage(image),
      boardId: image.board_id,
    };
    json(ctx.res, 200, response);
  });

  router.get('/images/:id/original', async (ctx) => {
    const userId = requireAuth(ctx);
    const image = await imageForViewing(userId, param(ctx, 'id'));
    const path = originalPath(image.board_id, image.sha256);
    try {
      const buf = readFileSync(path);
      ctx.res.writeHead(200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'private, max-age=3600',
      });
      ctx.res.end(buf);
    } catch {
      json(ctx.res, 404, { error: 'original missing' });
    }
  });

  router.patch('/images/:id', async (ctx) => {
    const userId = requireAuth(ctx);
    const image = await imageForViewing(userId, param(ctx, 'id'));
    const body = (await readJsonBody(ctx.req)) as UpdateImagePropertiesRequest;
    const { rows } = await pool.query(
      'UPDATE images SET properties = $1 WHERE id = $2 RETURNING properties',
      [JSON.stringify(body.properties), image.id],
    );
    const response: UpdateImagePropertiesResponse = {
      properties: rows[0].properties,
    };
    json(ctx.res, 200, response);
  });

  router.get('/boards/:id/tiles/:sortId/:z/:x/:yfile', async (ctx) => {
    const userId = requireAuth(ctx);
    const boardId = param(ctx, 'id');
    await boardForViewing(userId, boardId);

    const sort = parseSortId(param(ctx, 'sortId'));
    if (!sort) return json(ctx.res, 400, { error: 'bad sort id' });

    const z = Number(param(ctx, 'z')) as Zoom;
    if (!ZOOMS.includes(z)) return json(ctx.res, 400, { error: 'bad zoom' });

    const m = /^(-?\d+)\.png$/.exec(param(ctx, 'yfile'));
    if (!m) return json(ctx.res, 400, { error: 'bad tile' });
    const x = Number(param(ctx, 'x'));
    const y = Number(m[1]);

    const result = await tileFor(
      boardId,
      sort,
      z,
      x,
      y,
      cellPx(z),
      ctx.url.pathname,
    );

    ctx.res.writeHead(200, {
      'Content-Type': 'image/png',
      'X-Cache': result.cache,
      'Server-Timing': `rank;dur=${result.rankMs.toFixed(2)}, compose;dur=${result.composeMs.toFixed(2)}`,
      'Cache-Control': 'private, max-age=60',
    });
    ctx.res.end(result.png);
  });

  router.get('/boards/:id/sections', async (ctx) => {
    const userId = requireAuth(ctx);
    const boardId = param(ctx, 'id');
    await boardForViewing(userId, boardId);
    const sort = parseSortOrDefault(ctx.url.searchParams.get('sort'));
    const response: GetSectionsResponse = await sectionsFor(boardId, sort);
    json(ctx.res, 200, response);
  });

  // Forces a rank rebuild and an immediate materialise for one sort —
  // docs/phases/1-map.md's definition of done ("after POST .../rebuild and
  // the materialise job, a z=-3 tile returns X-Cache: disk"). Everything
  // else reaches a rebuild lazily (ensureRank) or via the debounced
  // rank-rebuild job; this route is for the measurement/manual path.
  router.post('/boards/:id/sort/:sortId/rebuild', async (ctx) => {
    const userId = requireAuth(ctx);
    const boardId = param(ctx, 'id');
    await boardForViewing(userId, boardId);
    const sort = parseSortId(param(ctx, 'sortId'));
    if (!sort) return json(ctx.res, 400, { error: 'bad sort id' });
    await forceRebuildRank(boardId, sort);
    await enqueueMaterialiseJob(boardId, param(ctx, 'sortId'));
    const response: RebuildSortResponse = { ok: true };
    json(ctx.res, 202, response);
  });
}
