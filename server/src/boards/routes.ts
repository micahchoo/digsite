// Boards (CONTEXT.md "Board", "Image", "Tile"). See docs/design.md
// "Routes / Boards" for the fixed route shapes.
import type {
  AllowlistRequest,
  AllowlistResponse,
  BoardFootprint,
  BoardImage,
  BoardImageWithRank,
  BoardSummary,
  CreateBoardRequest,
  CreateBoardResponse,
  GetBoardAllowlistResponse,
  GetBoardRelationsResponse,
  GetBoardResponse,
  GetImageResponse,
  GetSectionsResponse,
  ListBoardImagesByIdsResponse,
  ListBoardImagesResponse,
  ListBoardsResponse,
  ListJobsResponse,
  RebuildSortResponse,
  RenameBoardRequest,
  RenameBoardResponse,
  RetryJobResponse,
  Role,
  SortableKey,
  UpdateBoardRequest,
  UpdateBoardResponse,
  UpdateImagePropertiesRequest,
  UpdateImagePropertiesResponse,
  UploadImagesResponse,
} from '@digsite/shared/api';
import { ZOOMS, type Zoom, cellPx } from '@digsite/shared/board/grid';
import { ladderAddress } from '@digsite/shared/board/ladder';
import {
  type PropertyType,
  type Sort,
  parseSortId,
  sortId as toSortId,
} from '@digsite/shared/board/sort';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { fromNodeHeaders } from 'better-auth/node';
import {
  type BoardRow,
  type ImageRow,
  boardForCreating,
  boardForDeleting,
  boardForManagingAllowlist,
  boardForUploading,
  boardForViewing,
  boardsForListing,
  imageForDeleting,
  imageForViewing,
} from '../access/index.ts';
import { allowlistMembersOf, allowlistOf } from '../access/reads.ts';
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
import { checkLimit, tooManyRequests } from '../limits.ts';
import { recordTileCache } from '../metrics.ts';
import {
  deletePrefix,
  presignedGetUrl,
  storageFromEnv,
} from '../storage/index.ts';
import { enqueueMaterialiseJob } from '../worker/jobs.ts';
import { getPage } from './ladder.ts';
import { originalKey, previewKey } from './paths.ts';
import { ensureRank, forceRebuildRank, imagesInRankOrder } from './ranks.ts';
import { sectionsFor } from './sections.ts';
import { tileFor } from './tiles.ts';
import { uploadOne } from './upload.ts';
import { validateUpload } from './validate.ts';

const PREVIEW_MAX_SIDE = 1024;
const PREVIEW_LADDER_SIZE = 128;

/** `GET /images/:id/preview`'s first choice: the original, scaled to at
 * most `PREVIEW_MAX_SIDE` on its longer side, encoded once and cached at
 * `previewKey` — a scaled decode is not cheap enough to redo per request
 * on a large original. Returns null when there is no original to read
 * (never throws for that; a genuinely corrupt file still throws, and the
 * caller falls back to the ladder). */
async function originalPreview(
  boardId: string,
  sha256: string,
): Promise<Buffer | null> {
  const storage = storageFromEnv();
  const cachedKey = previewKey(boardId, sha256);
  const cached = await storage.get(cachedKey);
  if (cached) return Buffer.from(cached);
  const original = await storage.get(originalKey(boardId, sha256));
  if (!original) return null;
  const img = await loadImage(Buffer.from(original));
  const scale = Math.min(1, PREVIEW_MAX_SIDE / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = createCanvas(w, h);
  canvas.getContext('2d').drawImage(img, 0, 0, w, h);
  const buf = canvas.encodeSync('png');
  await storage.put(cachedKey, buf, 'image/png');
  return buf;
}

/** The fallback when the original is gone (CONTEXT.md "Missing" — the
 * synthetic million-image board's own shape: ladder pages painted at
 * upload, no original ever kept): this image's S=128 ladder cell, cropped
 * out of its resident page. `getPage` never throws for a missing page file
 * (paints the `#222` background instead — boards/ladder.ts), so this is
 * cheap and always produces something for any real slot. */
async function ladderPreview(boardId: string, slot: number): Promise<Buffer> {
  const { page, x, y } = ladderAddress(slot, PREVIEW_LADDER_SIZE);
  const pageCanvas = await getPage(boardId, PREVIEW_LADDER_SIZE, page);
  const canvas = createCanvas(PREVIEW_LADDER_SIZE, PREVIEW_LADDER_SIZE);
  canvas
    .getContext('2d')
    .drawImage(
      pageCanvas,
      x,
      y,
      PREVIEW_LADDER_SIZE,
      PREVIEW_LADDER_SIZE,
      0,
      0,
      PREVIEW_LADDER_SIZE,
      PREVIEW_LADDER_SIZE,
    );
  return canvas.encodeSync('png');
}

/** A role string from `member`/`teamMember` joins can be comma-joined
 * (better-auth's `parseRoles`) — same parse access/index.ts#isOwnerOrAdmin
 * does, duplicated here because this is a display-layer decision over
 * already-read rows, not a membership read (access/reads.ts already did
 * that part) — see .claude/rules/access-one-function-per-intent.md. */
function hasManagerRole(role: string): boolean {
  const roles = role.split(',').map((r) => r.trim());
  return roles.includes('owner') || roles.includes('admin');
}

// Phase 3 section 5 (docs/phases/3-groups.md): GET /groups/:id/boards'
// sheetCount/lastActivity, one query for every listed board rather than one
// per board — same "boardsForListing is one query" discipline as the access
// function itself (.claude/rules/access-one-function-per-intent.md).
type BoardStats = { sheetCount: number; lastActivity: string | null };
async function statsForBoards(
  boardIds: string[],
): Promise<Map<string, BoardStats>> {
  if (boardIds.length === 0) return new Map();
  const { rows } = await pool.query(
    `SELECT s.board_id, COUNT(*) AS sheet_count, MAX(ss.saved_at) AS last_activity
     FROM sheets s LEFT JOIN sheet_snapshots ss ON ss.sheet_id = s.id
     WHERE s.board_id = ANY($1::uuid[])
     GROUP BY s.board_id`,
    [boardIds],
  );
  return new Map(
    rows.map((r) => [
      r.board_id,
      {
        sheetCount: Number(r.sheet_count),
        lastActivity: r.last_activity ? r.last_activity.toISOString() : null,
      },
    ]),
  );
}

function toBoardSummary(b: BoardRow, stats: BoardStats): BoardSummary {
  return {
    id: b.id,
    name: b.name,
    open: b.open,
    imageCount: b.image_count,
    groupId: b.org_id,
    sheetCount: stats.sheetCount,
    lastActivity: stats.lastActivity,
  };
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
    const stats = await statsForBoards(boards.map((b) => b.id));
    const response: ListBoardsResponse = boards.map((b) =>
      toBoardSummary(
        b,
        stats.get(b.id) ?? { sheetCount: 0, lastActivity: null },
      ),
    );
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
      groupId: board.org_id,
    };
    json(ctx.res, 200, response);
  });

  // PATCH /boards/:id {name} (docs/phases/3-groups.md section 4) beside the
  // pre-existing {defaultSort} — branched on which field the body carries,
  // same route either way. Both are gated under boardForDeleting (creator
  // or org owner/admin): the doc groups rename with delete under that one
  // intent, and boardForDeleting is boardForManagingAllowlist's own
  // predicate (see access/index.ts), so this is not a behaviour change for
  // the pre-existing defaultSort path.
  router.patch('/boards/:id', async (ctx) => {
    const userId = requireAuth(ctx);
    const boardId = param(ctx, 'id');
    await boardForDeleting(userId, boardId);
    const body = (await readJsonBody(ctx.req)) as UpdateBoardRequest &
      RenameBoardRequest;
    if (body.name !== undefined) {
      const name = body.name.trim();
      if (!name) return json(ctx.res, 400, { error: 'name required' });
      await pool.query('UPDATE boards SET name = $1 WHERE id = $2', [
        name,
        boardId,
      ]);
      const response: RenameBoardResponse = { name };
      return json(ctx.res, 200, response);
    }
    if (body.defaultSort !== undefined) {
      if (!parseSortId(body.defaultSort)) {
        return json(ctx.res, 400, { error: 'bad sort id' });
      }
      await pool.query('UPDATE boards SET default_sort = $1 WHERE id = $2', [
        body.defaultSort,
        boardId,
      ]);
      const response: UpdateBoardResponse = { defaultSort: body.defaultSort };
      return json(ctx.res, 200, response);
    }
    json(ctx.res, 400, { error: 'nothing to update' });
  });

  // DELETE /boards/:id (docs/phases/3-groups.md section 4): every row that
  // names this board, in the doc's own order (children before the parents
  // that FK to them — board_ranks lost its FK in 0004_ranks_no_fk.sql but
  // board_rank_state did not, see ranks.ts's header comment), in one
  // transaction; the private board's team (best-effort — see below) and a
  // best-effort sweep of its files, after the transaction commits.
  router.del('/boards/:id', async (ctx) => {
    const userId = requireAuth(ctx);
    const boardId = param(ctx, 'id');
    const board = await boardForDeleting(userId, boardId);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'DELETE FROM edges WHERE sheet_id IN (SELECT id FROM sheets WHERE board_id = $1)',
        [boardId],
      );
      await client.query(
        'DELETE FROM regions WHERE sheet_id IN (SELECT id FROM sheets WHERE board_id = $1)',
        [boardId],
      );
      await client.query(
        'DELETE FROM sheet_snapshots WHERE sheet_id IN (SELECT id FROM sheets WHERE board_id = $1)',
        [boardId],
      );
      await client.query(
        'DELETE FROM sheet_images WHERE sheet_id IN (SELECT id FROM sheets WHERE board_id = $1)',
        [boardId],
      );
      await client.query('DELETE FROM sheets WHERE board_id = $1', [boardId]);
      await client.query('DELETE FROM board_ranks WHERE board_id = $1', [
        boardId,
      ]);
      await client.query('DELETE FROM board_rank_state WHERE board_id = $1', [
        boardId,
      ]);
      await client.query(`DELETE FROM jobs WHERE payload->>'boardId' = $1`, [
        boardId,
      ]);
      await client.query('DELETE FROM images WHERE board_id = $1', [boardId]);
      await client.query('DELETE FROM boards WHERE id = $1', [boardId]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // The plugin refuses to remove an organization's LAST team
    // (UNABLE_TO_REMOVE_LAST_TEAM, crud-team.mjs) unless
    // `teams.allowRemovingAllTeams` is set — it isn't (auth.ts, out of this
    // task's file scope). With `teams.defaultTeam` off, a group with
    // exactly one private board has exactly one team, so deleting that
    // board's only private board hits this every time. The board row is
    // already gone at this point either way, so a team the plugin won't let
    // us remove is left orphaned rather than failing the whole delete —
    // harmless, since every read here reaches a team only through a board's
    // own team_id (access/index.ts, access/reads.ts), and a deleted board
    // has none.
    if (board.team_id) {
      try {
        await auth.api.removeTeam({
          body: { teamId: board.team_id, organizationId: board.org_id },
          headers: fromNodeHeaders(ctx.req.headers),
        });
      } catch {
        // orphaned team, see above — not reported to the caller.
      }
    }

    // Best-effort file sweep (docs/phases/3-groups.md section 4, made
    // adapter-agnostic by docs/phases/5-hardening.md section 5's
    // `Storage.list`): every storage key for this board's originals, ladder
    // pages and tiles lives under this one prefix (paths.ts, ladder.ts,
    // materialise.ts, coarse-cache.ts, tiles.ts all key off `boards/<id>/`).
    // Runs on fs and s3 alike now; still best-effort — a failure here never
    // fails the response, since the DB rows are already gone regardless,
    // and this exercises the same sweep the load run in
    // docs/measurements/phase-5.md deletes its boards through.
    try {
      await deletePrefix(storageFromEnv(), `boards/${boardId}/`);
    } catch {
      // best-effort — the DB rows are already gone regardless.
    }

    json(ctx.res, 200, {});
  });

  // GET /boards/:id/footprint (docs/phases/3-groups.md section 4): the
  // delete confirmation's counts, under the same intent as the delete
  // itself.
  router.get('/boards/:id/footprint', async (ctx) => {
    const userId = requireAuth(ctx);
    const boardId = param(ctx, 'id');
    await boardForDeleting(userId, boardId);
    const { rows } = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM images WHERE board_id = $1) AS images,
         (SELECT COUNT(*) FROM sheets WHERE board_id = $1) AS sheets,
         (SELECT COUNT(*) FROM regions WHERE sheet_id IN (SELECT id FROM sheets WHERE board_id = $1)) AS regions,
         (SELECT COUNT(*) FROM edges WHERE sheet_id IN (SELECT id FROM sheets WHERE board_id = $1)) AS edges`,
      [boardId],
    );
    const r = rows[0];
    const response: BoardFootprint = {
      images: Number(r.images),
      sheets: Number(r.sheets),
      regions: Number(r.regions),
      edges: Number(r.edges),
    };
    json(ctx.res, 200, response);
  });

  // GET /boards/:id/allowlist (docs/phases/3-groups.md section 3): full
  // member rows for the board's allowlist, under boardForViewing — any
  // viewer of the board may see who is on it; boardForManagingAllowlist
  // still gates add/remove below.
  router.get('/boards/:id/allowlist', async (ctx) => {
    const userId = requireAuth(ctx);
    const boardId = param(ctx, 'id');
    const board = await boardForViewing(userId, boardId);
    const members = board.team_id
      ? await allowlistMembersOf(board.team_id, board.org_id)
      : [];
    const response: GetBoardAllowlistResponse = {
      groupId: board.org_id,
      members: members.map((m) => ({ ...m, role: m.role as Role })),
    };
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
    const response: AllowlistResponse = await allowlistOf(board.team_id);
    json(ctx.res, 200, response);
  });

  router.del('/boards/:id/allowlist/:userId', async (ctx) => {
    const userId = requireAuth(ctx);
    const boardId = param(ctx, 'id');
    const targetUserId = param(ctx, 'userId');
    const board = await boardForManagingAllowlist(userId, boardId);
    if (!board.team_id)
      return json(ctx.res, 400, { error: 'board has no allowlist' });
    // docs/phases/3-groups.md section 3: the creator may remove themself
    // only if another allowlisted user can still manage the board (is
    // owner/admin of the group) — otherwise the board is left with nobody
    // able to reach boardForManagingAllowlist on it at all.
    if (targetUserId === board.created_by) {
      const others = await allowlistMembersOf(board.team_id, board.org_id);
      const hasManager = others.some(
        (m) => m.userId !== targetUserId && hasManagerRole(m.role),
      );
      if (!hasManager) {
        return json(ctx.res, 400, {
          reason: 'the board would have no manager left on its allowlist',
        });
      }
    }
    await auth.api.removeTeamMember({
      body: {
        teamId: board.team_id,
        userId: targetUserId,
        organizationId: board.org_id,
      },
      headers: fromNodeHeaders(ctx.req.headers),
    });
    const response: AllowlistResponse = await allowlistOf(board.team_id);
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

    // Phase 5 section 2 (docs/phases/5-hardening.md "Abuse limits"): the
    // bucket is charged for the whole batch at once (one request with 50
    // files is 50 uploads, not one) — checked before touching any file's
    // bytes, so an over-limit caller pays for parsing the multipart body
    // but nothing past it.
    const limit = checkLimit('upload', userId, files.length);
    if (!limit.allowed) {
      return tooManyRequests(ctx.res, 'upload', limit.retryAfter);
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

    // Every file is read and validated (real type by magic bytes, size,
    // pixel budget — boards/validate.ts) BEFORE any of them is stored or
    // enqueued: one bad file in a batch refuses the whole request instead
    // of leaving a partial upload the client has to reconcile.
    const fileBytes: Uint8Array[] = [];
    for (const file of files) {
      fileBytes.push(new Uint8Array(await file.arrayBuffer()));
    }
    for (const [i, bytes] of fileBytes.entries()) {
      const result = validateUpload(bytes);
      if (!result.ok) {
        return json(ctx.res, result.status, {
          error: result.reason,
          file: files[i]?.name ?? null,
        });
      }
    }

    const out: UploadImagesResponse = [];
    const ids: string[] = [];
    for (const [i, file] of files.entries()) {
      const bytes = fileBytes[i] ?? new Uint8Array();
      const properties = propsArray[i] ?? {};
      const uploaded = await uploadOne(
        boardId,
        userId,
        file.name || `upload-${Date.now()}`,
        bytes,
        properties,
        file.type || 'application/octet-stream',
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

    // Phase 2 section 4 (docs/phases/2-sheet.md): `ids=<comma-separated
    // image ids>` answers with exactly those images, order preserved, each
    // carrying its RANK under `sort` (via ensureRank first) — not on the
    // real server before this phase (web/src/lib/api.ts's own TODO on
    // getBoardImagesByIds); `from`/`count` are ignored when `ids` is given,
    // same as the dev stub.
    const idsParam = ctx.url.searchParams.get('ids');
    if (idsParam !== null) {
      const wanted = idsParam.split(',').filter(Boolean);
      if (wanted.length === 0) {
        const response: ListBoardImagesByIdsResponse = { images: [] };
        return json(ctx.res, 200, response);
      }
      await ensureRank(boardId, sort);
      const sid = toSortId(sort);
      const { rows } = await pool.query(
        `SELECT i.*, br.rank FROM images i
         LEFT JOIN board_ranks br
           ON br.board_id = i.board_id AND br.sort_id = $2 AND br.slot = i.slot
         WHERE i.board_id = $1 AND i.id = ANY($3::uuid[])`,
        [boardId, sid, wanted],
      );
      const byId = new Map(rows.map((r) => [r.id, r]));
      const images: BoardImageWithRank[] = wanted
        .map((id) => byId.get(id))
        .filter((r): r is NonNullable<typeof r> => !!r)
        .map((r) => ({
          ...toBoardImage(r),
          rank:
            r.rank === null || r.rank === undefined
              ? undefined
              : Number(r.rank),
        }));
      const response: ListBoardImagesByIdsResponse = { images };
      return json(ctx.res, 200, response);
    }

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

  // GET /boards/:id/relations (docs/phases/2-sheet.md section 4 /
  // web/src/lib/api.ts's TODO): distinct relations across every sheet's own
  // edges on this board, for the Explore panel's relation filter.
  router.get('/boards/:id/relations', async (ctx) => {
    const userId = requireAuth(ctx);
    const boardId = param(ctx, 'id');
    await boardForViewing(userId, boardId);
    const { rows } = await pool.query(
      `SELECT DISTINCT e.relation FROM edges e
       JOIN sheets s ON s.id = e.sheet_id
       WHERE s.board_id = $1 AND e.relation != ''
       ORDER BY e.relation`,
      [boardId],
    );
    const response: GetBoardRelationsResponse = rows.map((r) => r.relation);
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

  // docs/phases/4-deploy.md section 2: with STORAGE=s3, a 302 to a 5-minute
  // presigned URL, so the original's bytes never pass through the server —
  // this route only ever proves the caller may see the image (imageForViewing)
  // and then hands out (or serves) the object. `private, max-age=300` either
  // way, matching the presigned URL's own lifetime under s3.
  router.get('/images/:id/original', async (ctx) => {
    const userId = requireAuth(ctx);
    const image = await imageForViewing(userId, param(ctx, 'id'));
    const key = originalKey(image.board_id, image.sha256);

    const presigned = await presignedGetUrl(key, 300);
    if (presigned) {
      ctx.res.writeHead(302, {
        Location: presigned,
        'Cache-Control': 'private, max-age=300',
      });
      ctx.res.end();
      return;
    }

    const buf = await storageFromEnv().get(key);
    if (!buf) return json(ctx.res, 404, { error: 'original missing' });
    ctx.res.writeHead(200, {
      'Content-Type': 'image/png',
      'Cache-Control': 'private, max-age=300',
    });
    ctx.res.end(Buffer.from(buf));
  });

  // GET /images/:id/preview: a small, fast image for a sheet to show
  // instead of the full original — the original scaled to at most 1024px
  // (cached once), or, when there is no original (a synthetic board's own
  // shape, or a purged upload), this image's S=128 ladder cell. `missing`
  // always 404s regardless of what's on disk — CONTEXT.md's "Missing" is a
  // placeholder state the sheet draws itself, not a fetch.
  router.get('/images/:id/preview', async (ctx) => {
    const userId = requireAuth(ctx);
    const image = await imageForViewing(userId, param(ctx, 'id'));
    if (image.missing) return json(ctx.res, 404, { error: 'missing' });

    let buf: Buffer | null = null;
    try {
      buf = await originalPreview(image.board_id, image.sha256);
    } catch {
      buf = null; // an unreadable/corrupt original — fall through to the ladder
    }
    if (!buf) {
      try {
        buf = await ladderPreview(image.board_id, image.slot);
      } catch {
        buf = null;
      }
    }
    if (!buf) return json(ctx.res, 404, { error: 'no preview available' });

    ctx.res.writeHead(200, {
      'Content-Type': 'image/png',
      'Cache-Control': 'private, max-age=300',
    });
    ctx.res.end(buf);
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

  // DELETE /images/:id (docs/phases/3-groups.md section 4): sets
  // `missing = true` and removes the original file; the row, the slot and
  // every claim on it stay — there is no hard delete of an image in this
  // phase. `uploadOne` dedupes an original by sha256 WITHIN a board, so two
  // images can share one file on disk; only unlink it when no other
  // non-missing image on the board still points at the same sha256.
  router.del('/images/:id', async (ctx) => {
    const userId = requireAuth(ctx);
    const imageId = param(ctx, 'id');
    const image = await imageForDeleting(userId, imageId);
    if (!image.missing) {
      const { rows } = await pool.query(
        `SELECT 1 FROM images
         WHERE board_id = $1 AND sha256 = $2 AND id != $3 AND missing = false
         LIMIT 1`,
        [image.board_id, image.sha256, image.id],
      );
      if (rows.length === 0) {
        // storage.delete is force-delete on both adapters (fs.ts, s3.ts) —
        // "already gone, or never written" needs no separate catch here.
        await storageFromEnv().delete(
          originalKey(image.board_id, image.sha256),
        );
      }
    }
    await pool.query('UPDATE images SET missing = true WHERE id = $1', [
      imageId,
    ]);
    json(ctx.res, 200, {});
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
    recordTileCache(result.cache);

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

  // Phase 5 section 4 (docs/phases/5-hardening.md "Operability"): every
  // enqueue* function in worker/jobs.ts puts `boardId` in the job's
  // payload (ladder, rank-rebuild, materialise all do), so filtering by
  // `payload->>'boardId'` covers every kind with one query — under
  // boardForManagingAllowlist, same gate as the allowlist and the delete
  // confirmation (this is operational visibility into the board, not a
  // viewer's concern).
  router.get('/boards/:id/jobs', async (ctx) => {
    const userId = requireAuth(ctx);
    const boardId = param(ctx, 'id');
    await boardForManagingAllowlist(userId, boardId);
    const state = ctx.url.searchParams.get('state') ?? 'failed';
    const { rows } = await pool.query(
      `SELECT id, kind, state, attempts, last_error, run_after, created_at
       FROM jobs WHERE payload->>'boardId' = $1 AND state = $2
       ORDER BY created_at DESC LIMIT 200`,
      [boardId, state],
    );
    const response: ListJobsResponse = rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      state: r.state,
      attempts: r.attempts,
      error: r.last_error,
      runAfter: r.run_after.toISOString(),
      createdAt: r.created_at.toISOString(),
    }));
    json(ctx.res, 200, response);
  });

  // POST /jobs/:id/retry — worker/index.ts's backoff/dead-letter puts a
  // job here after MAX_ATTEMPTS_BACKOFF failures; this resets it to
  // pending, attempts 0, due immediately, same as a brand-new job. The
  // job id alone doesn't say who may retry it, so the board id is read out
  // of its own payload first (every kind carries one) and THAT is what
  // boardForManagingAllowlist gates on — the same "existence must not
  // leak" shape as sheetForDeleting (access/index.ts): a job that doesn't
  // exist and a job on a board this user can't manage both refuse, the
  // first with 404 (nothing to leak — no board id to check access
  // against) and the second with 403.
  router.post('/jobs/:id/retry', async (ctx) => {
    const userId = requireAuth(ctx);
    const jobId = Number(param(ctx, 'id'));
    if (!Number.isInteger(jobId)) {
      return json(ctx.res, 400, { error: 'bad job id' });
    }
    const { rows } = await pool.query(
      'SELECT id, payload, state FROM jobs WHERE id = $1',
      [jobId],
    );
    const job = rows[0];
    if (!job) return json(ctx.res, 404, { reason: 'job not found' });
    const boardId = (job.payload as { boardId?: string }).boardId;
    if (!boardId) return json(ctx.res, 404, { reason: 'job not found' });
    await boardForManagingAllowlist(userId, boardId);
    if (job.state !== 'failed') {
      return json(ctx.res, 400, { error: 'job is not failed' });
    }
    await pool.query(
      `UPDATE jobs SET state = 'pending', attempts = 0, run_after = now(), last_error = NULL WHERE id = $1`,
      [jobId],
    );
    const response: RetryJobResponse = { ok: true };
    json(ctx.res, 200, response);
  });
}
