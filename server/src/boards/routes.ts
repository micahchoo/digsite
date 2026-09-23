// Boards (CONTEXT.md "Board", "Image", "Tile"). See docs/design.md
// "Routes / Boards" for the fixed route shapes.
import type {
  AliasesResponse,
  AllowlistRequest,
  AllowlistResponse,
  BoardFootprint,
  BoardImage,
  BoardImageWithRank,
  BoardSummary,
  CreateBoardRequest,
  CreateBoardResponse,
  FindBoardResponse,
  FolderImport,
  GetBoardAllowlistResponse,
  GetBoardResponse,
  GetBoardSelectionResponse,
  GetBoardVocabularyResponse,
  GetImageResponse,
  GetSectionsResponse,
  LabelSuggestionsResponse,
  ListBoardImagesByIdsResponse,
  ListBoardImagesResponse,
  ListBoardsResponse,
  ListJobsResponse,
  MeaningResponse,
  PutAliasRequest,
  PutBoardSelectionRequest,
  PutBoardSelectionResponse,
  RebuildSortResponse,
  RenameBoardRequest,
  RenameBoardResponse,
  RetryJobResponse,
  Role,
  SelectionRangeRequest,
  SelectionRangeResponse,
  SortableKey,
  StartFolderImportRequest,
  UpdateBoardRequest,
  UpdateBoardResponse,
  UpdateImagePropertiesRequest,
  UpdateImagePropertiesResponse,
  UploadImageStatusesResponse,
  UploadImagesResponse,
} from '@digsite/shared/api';
import {
  GRID_LAYOUT_VERSION,
  ZOOMS,
  type Zoom,
  cellPx,
} from '@digsite/shared/board/grid';
import { ladderAddress } from '@digsite/shared/board/ladder';
import {
  type PropertyType,
  type Sort,
  parseSortId,
  sortId as toSortId,
} from '@digsite/shared/board/sort';
import { SHEET_LIMIT } from '@digsite/shared/sheet/elements';
import { type Canvas, createCanvas } from '@napi-rs/canvas';
import { fromNodeHeaders } from 'better-auth/node';
import sharp from 'sharp';
import {
  type BoardRow,
  type ImageRow,
  boardForAliasing,
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
import { env } from '../env.ts';
import { recordActivity } from '../groups/activity.ts';
import {
  RequestBodyTooLargeError,
  type Router,
  json,
  param,
  readJsonBody,
  requireAuth,
  toWebRequest,
} from '../http.ts';
import { checkLimit, tooManyRequests } from '../limits.ts';
import { duplicatesOf } from '../meaning/duplicates.ts';
import { suggestLabels } from '../meaning/labels.ts';
import { searchText, similarTo } from '../meaning/search.ts';
import { recordTileCache } from '../metrics.ts';
import {
  deletePrefix,
  presignedGetUrl,
  storageFromEnv,
} from '../storage/index.ts';
import { Semaphore } from '../util/semaphore.ts';
import { enqueueMaterialiseJob } from '../worker/jobs.ts';
import { extractRegion, parseFraction } from './extract.ts';
import type { FilterClause } from './filter.ts';
import { findRanks } from './find.ts';
import {
  ImportRefused,
  folderImport,
  startFolderImport,
} from './folder-import.ts';
import { withPage } from './ladder.ts';
import { originalKey, previewKey } from './paths.ts';
import { isProperties } from './properties.ts';
import {
  ensureRank,
  forceRebuildRank,
  imageIdsInRankBand,
  imageIdsInRankRange,
  imagesInRankOrder,
  markBoardRanksStale,
  rankOf,
  rankOrder,
} from './ranks.ts';
import { sectionsFor } from './sections.ts';
import { tileFor } from './tiles.ts';
import { uploadOne } from './upload.ts';
import { validateUpload } from './validate.ts';
import {
  aliasesOf,
  deleteAlias,
  putAlias,
  vocabularyOf,
} from './vocabulary.ts';

const SELECTION_CAP = 5000;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const PREVIEW_MAX_SIDE = 1024;
const PREVIEW_LADDER_SIZE = 128;

// docs/measurements/phase-5.md "After the leftovers", problem 1, lead
// review round 2's site audit: both preview functions below used to call
// `createCanvas` per request. Each result is cached permanently
// (`originalPreview` to `previewKey`/disk; `ladderPreview`'s own caller,
// the /images/:id/preview route, doesn't cache it — a synthetic board with
// no originals, like every board this whole task measured against, calls
// it on EVERY request for such an image), so this was a slower-growing
// leak than the tile/ladder ones (bounded by distinct images previewed,
// not by request volume, for `originalPreview`) but the same defect class.
//
// `originalPreview` now scales with libvips and needs no canvas.
// `ladderPreview`'s output is always exactly PREVIEW_LADDER_SIZE square, so
// its pool is the same shape as ladder.ts's page pool. Both are gated by a
// semaphore, same invariant as ladder.ts/tiles.ts: canvases ever created <=
// concurrency limit, not bounded by a capped free list.
const PREVIEW_CONCURRENCY = 8;
const previewSemaphore = new Semaphore(PREVIEW_CONCURRENCY);
const ladderPreviewPool: Canvas[] = [];

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
  // libvips, not @napi-rs/canvas: that library's decoder rejects some
  // valid images (ladder.ts#decodePage), and a JPEG shrinks while decoding.
  return previewSemaphore.run(async () => {
    const buf = await sharp(Buffer.from(original), {
      limitInputPixels: env.UPLOAD_MAX_PIXELS,
    })
      .rotate()
      .resize(PREVIEW_MAX_SIDE, PREVIEW_MAX_SIDE, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .png()
      .toBuffer();
    await storage.put(cachedKey, buf, 'image/png');
    return buf;
  });
}

/** The fallback when the original is gone (CONTEXT.md "Missing" — the
 * synthetic million-image board's own shape: ladder pages painted at
 * upload, no original ever kept): this image's S=128 ladder cell, cropped
 * out of its resident page. `withPage` never throws for a missing page
 * file (paints the `#222` background instead — boards/ladder.ts), so this
 * is cheap and always produces something for any real slot. */
async function ladderPreview(boardId: string, slot: number): Promise<Buffer> {
  const { page, x, y } = ladderAddress(slot, PREVIEW_LADDER_SIZE);
  return previewSemaphore.run(() =>
    withPage(boardId, PREVIEW_LADDER_SIZE, page, (pageCanvas) => {
      const canvas =
        ladderPreviewPool.pop() ??
        createCanvas(PREVIEW_LADDER_SIZE, PREVIEW_LADDER_SIZE);
      try {
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, PREVIEW_LADDER_SIZE, PREVIEW_LADDER_SIZE);
        ctx.drawImage(
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
      } finally {
        ladderPreviewPool.push(canvas);
      }
    }),
  );
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
    `SELECT e.key, jsonb_typeof(e.value) AS t,
       bool_and(CASE WHEN jsonb_typeof(e.value) = 'string'
         THEN e.value #>> '{}' ~ '^\\d{4}-\\d{2}-\\d{2}$' ELSE false END) AS dates
     FROM images i, jsonb_each(i.properties) e
     WHERE i.board_id = $1
     GROUP BY e.key, jsonb_typeof(e.value)`,
    [boardId],
  );
  const typesByKey = new Map<string, Map<string, boolean>>();
  for (const r of rows) {
    const entry = typesByKey.get(r.key) ?? new Map<string, boolean>();
    entry.set(r.t, r.dates === true);
    typesByKey.set(r.key, entry);
  }
  for (const [propKey, types] of typesByKey) {
    if (types.size !== 1) continue; // mixed JSON types: not sortable
    const jsonType = [...types.keys()][0];
    let type: PropertyType | null = null;
    if (jsonType === 'string') {
      type = types.get(jsonType) ? 'date' : 'text';
    } else if (jsonType === 'number') type = 'number';
    else if (jsonType === 'boolean') type = 'boolean';
    else if (jsonType === 'array') type = 'list';
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
    const boardId: string = rows[0].id;

    // docs/phases/6-product.md "Group activity feed": "board created" —
    // best-effort, never fails board creation itself.
    try {
      await recordActivity(orgId, boardId, 'board_created', userId, {
        boardName: body.name,
      });
    } catch {
      // best-effort — the board is already committed regardless.
    }

    const response: CreateBoardResponse = { id: boardId };
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
  // that FK to them — board_rank_state, which holds each sort's whole order
  // since 0017_rank_order.sql, keeps its FK), in one
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
        'DELETE FROM sheet_reads WHERE sheet_id IN (SELECT id FROM sheets WHERE board_id = $1)',
        [boardId],
      );
      await client.query(
        'DELETE FROM sheet_images WHERE sheet_id IN (SELECT id FROM sheets WHERE board_id = $1)',
        [boardId],
      );
      await client.query('DELETE FROM sheets WHERE board_id = $1', [boardId]);
      await client.query('DELETE FROM board_rank_state WHERE board_id = $1', [
        boardId,
      ]);
      await client.query('DELETE FROM term_aliases WHERE board_id = $1', [
        boardId,
      ]);
      await client.query('DELETE FROM board_selections WHERE board_id = $1', [
        boardId,
      ]);
      await client.query(
        'DELETE FROM board_property_indexes WHERE board_id = $1',
        [boardId],
      );
      await client.query('DELETE FROM activity WHERE board_id = $1', [boardId]);
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
    const board = await boardForUploading(userId, boardId);

    let form: Awaited<ReturnType<Request['formData']>>;
    try {
      const webReq = await toWebRequest(ctx.req);
      form = await webReq.formData();
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        return json(ctx.res, 413, {
          error: `multipart request exceeds ${env.UPLOAD_BATCH_MAX_MB}MB limit`,
        });
      }
      throw error;
    }
    const files: File[] = [];
    for (const entry of form.getAll('files')) {
      if (typeof entry !== 'string') files.push(entry);
    }
    if (files.length === 0) {
      return json(ctx.res, 400, { error: 'no files' });
    }
    if (files.length > 100) {
      return json(ctx.res, 413, {
        error: 'a batch may contain at most 100 files',
      });
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
        if (
          !Array.isArray(parsed) ||
          parsed.length !== files.length ||
          !parsed.every(isProperties)
        ) {
          return json(ctx.res, 400, {
            error: 'properties must be one valid object per file',
          });
        }
        propsArray = parsed;
      } catch {
        return json(ctx.res, 400, { error: 'properties must be valid JSON' });
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

    // docs/phases/6-product.md "Group activity feed": "images uploaded" —
    // ONE row per request (batched: "Micah uploaded 40 images", never one
    // row per file — design.md §4.3's own guestbook copy), best-effort.
    if (ids.length > 0) {
      try {
        await recordActivity(board.org_id, boardId, 'images_uploaded', userId, {
          count: ids.length,
        });
      } catch {
        // best-effort — the images are already committed regardless.
      }
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

  router.post('/boards/:id/images/status', async (ctx) => {
    const boardId = param(ctx, 'id');
    await boardForViewing(requireAuth(ctx), boardId);
    const body = await readJsonBody(ctx.req);
    const ids =
      body && typeof body === 'object' && 'ids' in body ? body.ids : undefined;
    if (
      !Array.isArray(ids) ||
      ids.length > 500 ||
      !ids.every((id) => typeof id === 'string' && UUID_RE.test(id))
    ) {
      return json(ctx.res, 400, {
        reason: 'ids must contain at most 500 image UUIDs',
      });
    }
    const { rows } = await pool.query<
      UploadImageStatusesResponse['images'][number]
    >(
      'SELECT id, status, error FROM images WHERE board_id = $1 AND id = ANY($2::uuid[])',
      [boardId, ids],
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    const response: UploadImageStatusesResponse = {
      images: ids.flatMap((id) => {
        const row = byId.get(id);
        return row ? [row] : [];
      }),
    };
    json(ctx.res, 200, response);
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
      const order = await rankOrder(boardId, sort);
      const { rows } = await pool.query(
        'SELECT * FROM images WHERE board_id = $1 AND id = ANY($2::uuid[])',
        [boardId, wanted],
      );
      const byId = new Map(rows.map((r) => [r.id, r]));
      const images: BoardImageWithRank[] = wanted
        .map((id) => byId.get(id))
        .filter((r): r is NonNullable<typeof r> => !!r)
        .map((r) => {
          // Uploaded after this build: not on the map yet, so no rank.
          const rank = rankOf(order, r.slot);
          return { ...toBoardImage(r), rank: rank < 0 ? undefined : rank };
        });
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

  // GET /boards/:id/vocabulary (CONTEXT.md "Vocabulary"): every label and
  // relation the board's sheets use, folded onto canonical terms, with the
  // aliases. What every label and relation field suggests from.
  router.get('/boards/:id/vocabulary', async (ctx) => {
    const userId = requireAuth(ctx);
    const boardId = param(ctx, 'id');
    await boardForViewing(userId, boardId);
    const response: GetBoardVocabularyResponse = await vocabularyOf(boardId);
    json(ctx.res, 200, response);
  });

  // PUT /boards/:id/aliases {kind, term, canonical}: `term` now means
  // `canonical` everywhere claims are read. No scene changes.
  router.put('/boards/:id/aliases', async (ctx) => {
    const userId = requireAuth(ctx);
    const boardId = param(ctx, 'id');
    await boardForAliasing(userId, boardId);
    const body = (await readJsonBody(ctx.req)) as Partial<PutAliasRequest>;
    const kind = body.kind;
    const term = typeof body.term === 'string' ? body.term.trim() : '';
    const canonical =
      typeof body.canonical === 'string' ? body.canonical.trim() : '';
    if (kind !== 'label' && kind !== 'relation') {
      return json(ctx.res, 400, { error: 'kind must be label or relation' });
    }
    if (!term || !canonical || term.length > 200 || canonical.length > 200) {
      return json(ctx.res, 400, {
        error: 'term and canonical must be 1 to 200 characters',
      });
    }
    if (!(await putAlias(boardId, kind, term, canonical, userId))) {
      return json(ctx.res, 400, { error: 'a term cannot mean itself' });
    }
    const response: AliasesResponse = await aliasesOf(boardId);
    json(ctx.res, 200, response);
  });

  // DELETE /boards/:id/aliases/:kind/:term: the term means itself again.
  router.del('/boards/:id/aliases/:kind/:term', async (ctx) => {
    const userId = requireAuth(ctx);
    const boardId = param(ctx, 'id');
    await boardForAliasing(userId, boardId);
    const kind = param(ctx, 'kind');
    if (kind !== 'label' && kind !== 'relation') {
      return json(ctx.res, 400, { error: 'kind must be label or relation' });
    }
    await deleteAlias(boardId, kind, param(ctx, 'term'));
    const response: AliasesResponse = await aliasesOf(boardId);
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
  // POST /images/:id/extract {fx, fy, fw, fh, label?} (CONTEXT.md
  // "Extract"): a region of this picture becomes a picture of its own on
  // the same board (extract.ts). Seeing the picture is not enough: it adds
  // an image, so it needs upload access and counts against the upload
  // limit.
  router.post('/images/:id/extract', async (ctx) => {
    const userId = requireAuth(ctx);
    const image = await imageForViewing(userId, param(ctx, 'id'));
    await boardForUploading(userId, image.board_id);
    if (image.missing) return json(ctx.res, 404, { error: 'missing' });
    const body = (await readJsonBody(ctx.req)) as Record<string, unknown>;
    const fraction = parseFraction(body);
    if (!fraction) {
      return json(ctx.res, 400, {
        error: 'fx, fy in 0..1 and fw, fh above 0 are required',
      });
    }
    const limit = checkLimit('upload', userId, 1);
    if (!limit.allowed) {
      return tooManyRequests(ctx.res, 'upload', limit.retryAfter);
    }
    const label =
      typeof body.label === 'string' ? body.label.slice(0, 120) : '';
    const extracted = await extractRegion(image, fraction, label, userId);
    if (!extracted) return json(ctx.res, 404, { error: 'no original to crop' });
    json(ctx.res, 202, extracted);
  });

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
    if (!isProperties(body.properties)) {
      return json(ctx.res, 400, {
        error: 'properties must be a valid property map',
      });
    }
    const client = await pool.connect();
    let properties: unknown;
    try {
      await client.query('BEGIN');
      const updated = await client.query(
        'UPDATE images SET properties = $1 WHERE id = $2 RETURNING properties',
        [JSON.stringify(body.properties), image.id],
      );
      properties = updated.rows[0].properties;
      await client.query(
        'UPDATE board_rank_state SET stale = true WHERE board_id = $1',
        [image.board_id],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    await markBoardRanksStale(image.board_id);
    const response: UpdateImagePropertiesResponse = {
      properties: properties as UpdateImagePropertiesResponse['properties'],
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
      `${ctx.url.pathname}?grid=${GRID_LAYOUT_VERSION}`,
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

  // GET/PUT /boards/:id/selection (docs/phases/6-product.md "Selection"):
  // a set of image ids owned by the viewer, per board — never ranks (a
  // rank changes with the sort; ../../.claude/rules/ladder-slot-vs-rank.md
  // "a pin or a selection on the map is a client overlay"). boardForViewing
  // is the one access function; the selection is the viewer's OWN, so
  // nothing stronger is needed to read or write it.
  router.get('/boards/:id/selection', async (ctx) => {
    const userId = requireAuth(ctx);
    const boardId = param(ctx, 'id');
    await boardForViewing(userId, boardId);
    const { rows } = await pool.query(
      'SELECT image_ids FROM board_selections WHERE user_id = $1 AND board_id = $2',
      [userId, boardId],
    );
    const response: GetBoardSelectionResponse = {
      imageIds: rows[0]?.image_ids ?? [],
    };
    json(ctx.res, 200, response);
  });

  router.put('/boards/:id/selection', async (ctx) => {
    const userId = requireAuth(ctx);
    const boardId = param(ctx, 'id');
    await boardForViewing(userId, boardId);
    const body = (await readJsonBody(ctx.req)) as PutBoardSelectionRequest;
    if (
      !Array.isArray(body.imageIds) ||
      !body.imageIds.every((id) => typeof id === 'string' && UUID_RE.test(id))
    ) {
      return json(ctx.res, 400, {
        error: 'imageIds must be an array of valid image ids',
      });
    }
    const requested = body.imageIds;

    // Dedupe, preserving first-seen (tray) order, then cap.
    const seen = new Set<string>();
    const deduped: string[] = [];
    for (const id of requested) {
      if (typeof id !== 'string' || seen.has(id)) continue;
      seen.add(id);
      deduped.push(id);
    }
    const capped = deduped.slice(0, SELECTION_CAP);

    // Every id must belong to this board — a stale id from a sort change
    // or a different board is dropped rather than stored, order preserved.
    let imageIds = capped;
    if (capped.length > 0) {
      const { rows } = await pool.query(
        'SELECT id FROM images WHERE board_id = $1 AND id = ANY($2::uuid[])',
        [boardId, capped],
      );
      const onBoard = new Set(rows.map((r) => r.id as string));
      imageIds = capped.filter((id) => onBoard.has(id));
    }

    await pool.query(
      `INSERT INTO board_selections (user_id, board_id, image_ids, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (user_id, board_id)
       DO UPDATE SET image_ids = $3, updated_at = now()`,
      [userId, boardId, imageIds],
    );
    const response: PutBoardSelectionResponse = { imageIds };
    json(ctx.res, 200, response);
  });

  // POST /boards/:id/selection/range {sort, fromRank, toRank} — resolves a
  // rank range to ids server-side (design.md §5.1) so a band/range select
  // over a million-cell board never pages ranks to the client.
  router.post('/boards/:id/selection/range', async (ctx) => {
    const userId = requireAuth(ctx);
    const boardId = param(ctx, 'id');
    await boardForViewing(userId, boardId);
    const body = (await readJsonBody(ctx.req)) as SelectionRangeRequest;
    const sort = parseSortId(body.sort);
    if (!sort) return json(ctx.res, 400, { error: 'bad sort id' });
    if (
      !Number.isSafeInteger(body.fromRank) ||
      !Number.isSafeInteger(body.toRank) ||
      body.fromRank > 2_147_483_647 ||
      body.toRank > 2_147_483_647 ||
      body.fromRank < 0 ||
      body.toRank < 0
    ) {
      return json(ctx.res, 400, {
        error: 'fromRank/toRank must be integers >= 0',
      });
    }
    if (body.mode !== undefined && body.mode !== 'band') {
      return json(ctx.res, 400, { error: 'bad selection mode' });
    }
    const imageIds =
      body.mode === 'band'
        ? await imageIdsInRankBand(
            boardId,
            sort,
            body.fromRank,
            body.toRank,
            SHEET_LIMIT,
          )
        : await imageIdsInRankRange(
            boardId,
            sort,
            body.fromRank,
            body.toRank,
            SELECTION_CAP,
          );
    const response: SelectionRangeResponse = { imageIds };
    json(ctx.res, 200, response);
  });

  // GET /boards/:id/find?sort=&q=&filter= (docs/phases/6-product.md "Find
  // and filter"): matches under the given sort as ranks, capped at 10,000,
  // ascending — reads the sort's current order like every other rank reader
  // (find.ts, ranks.ts#rankOrder).
  router.get('/boards/:id/find', async (ctx) => {
    const userId = requireAuth(ctx);
    const boardId = param(ctx, 'id');
    await boardForViewing(userId, boardId);
    const sort = parseSortOrDefault(ctx.url.searchParams.get('sort'));
    const q = ctx.url.searchParams.get('q');
    if (q !== null && q.length > 200) {
      return json(ctx.res, 400, { error: 'q must be at most 200 characters' });
    }

    let filter: FilterClause[] = [];
    const filterParam = ctx.url.searchParams.get('filter');
    if (filterParam) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(filterParam);
      } catch {
        return json(ctx.res, 400, { error: 'filter must be JSON' });
      }
      if (!Array.isArray(parsed)) {
        return json(ctx.res, 400, { error: 'filter must be an array' });
      }
      if (parsed.length > 32) {
        return json(ctx.res, 400, {
          error: 'filter supports at most 32 clauses',
        });
      }
      filter = parsed as FilterClause[];
    }

    try {
      const label = ctx.url.searchParams.get('label');
      const relation = ctx.url.searchParams.get('relation');
      if ((label?.length ?? 0) > 200 || (relation?.length ?? 0) > 200) {
        return json(ctx.res, 400, {
          error: 'label and relation must be at most 200 characters',
        });
      }
      const { ranks, imageIds, count } = await findRanks(
        boardId,
        sort,
        q,
        filter,
        {
          ...(label ? { label } : {}),
          ...(relation ? { relation } : {}),
          annotated: ctx.url.searchParams.get('annotated') === '1',
        },
      );
      const response: FindBoardResponse = { ranks, imageIds, count };
      json(ctx.res, 200, response);
    } catch (err) {
      // filter.ts#buildFilterSql throws a plain Error for anything the
      // grammar rejects (bad op for the property's type, wrong value
      // shape, and so on) — the one place that becomes a 400 instead of a
      // 500, same "strict on write" posture as image-graph's shard
      // validation.
      if (err instanceof Error) {
        return json(ctx.res, 400, { error: err.message });
      }
      throw err;
    }
  });

  // GET /boards/:id/similar?image=&sort=&limit= and GET /boards/:id/search?
  // text=&sort=&limit= (CONTEXT.md "Embedding", roadmap stage 4): images by
  // meaning, best first, as ranks under the viewer's sort — the shape find
  // returns, so the map dims the rest the same way. 503 while embeddings are
  // off (env.EMBEDDINGS).
  const MEANING_LIMIT = 1_000;
  function meaningLimit(ctx: { url: URL }): number {
    const asked = Number(ctx.url.searchParams.get('limit') ?? SHEET_LIMIT);
    return Number.isInteger(asked) && asked > 0
      ? Math.min(asked, MEANING_LIMIT)
      : SHEET_LIMIT;
  }

  // GET /boards/:id/duplicates?image=&sort= (CONTEXT.md "Near-duplicate")
  // has the same shape: the images that are nearly this one, which a
  // person may then accept or decline. `meaning/duplicates.ts` says why
  // it takes pixels as well as meaning.
  for (const [path, find] of [
    [
      '/boards/:id/similar',
      (boardId: string, image: string, sort: Sort, ctx: { url: URL }) =>
        similarTo(boardId, image, sort, meaningLimit(ctx)),
    ],
    [
      '/boards/:id/duplicates',
      (boardId: string, image: string, sort: Sort) =>
        duplicatesOf(boardId, image, sort),
    ],
  ] as const) {
    router.get(path, async (ctx) => {
      const userId = requireAuth(ctx);
      const boardId = param(ctx, 'id');
      await boardForViewing(userId, boardId);
      if (!env.EMBEDDINGS) {
        return json(ctx.res, 503, { error: 'embeddings are off' });
      }
      const image = ctx.url.searchParams.get('image') ?? '';
      // The anchor must be on this board: an image of a board the viewer
      // cannot see must not become a query here.
      const { rows } = await pool.query(
        'SELECT 1 FROM images WHERE board_id = $1 AND id::text = $2',
        [boardId, image],
      );
      if (rows.length === 0) {
        return json(ctx.res, 400, { error: 'image is not on this board' });
      }
      const sort = parseSortOrDefault(ctx.url.searchParams.get('sort'));
      const matches = await find(boardId, image, sort, ctx);
      if (matches === null) {
        return json(ctx.res, 409, { error: 'image is not embedded yet' });
      }
      const response: MeaningResponse = { matches };
      return json(ctx.res, 200, response);
    });
  }

  // GET /boards/:id/label-suggestions?image=&limit= (meaning/labels.ts):
  // the board's own label terms that best describe the image, best first,
  // as {suggestions: [{term, score}]}. Statuses as /similar.
  router.get('/boards/:id/label-suggestions', async (ctx) => {
    const userId = requireAuth(ctx);
    const boardId = param(ctx, 'id');
    await boardForViewing(userId, boardId);
    if (!env.EMBEDDINGS) {
      return json(ctx.res, 503, { error: 'embeddings are off' });
    }
    const image = ctx.url.searchParams.get('image') ?? '';
    const { rows } = await pool.query(
      'SELECT 1 FROM images WHERE board_id = $1 AND id::text = $2',
      [boardId, image],
    );
    if (rows.length === 0) {
      return json(ctx.res, 400, { error: 'image is not on this board' });
    }
    const asked = Number(ctx.url.searchParams.get('limit') ?? 5);
    const limit =
      Number.isInteger(asked) && asked > 0 ? Math.min(asked, 50) : 5;
    const suggestions = await suggestLabels(boardId, image, limit);
    if (suggestions === null) {
      return json(ctx.res, 409, { error: 'image is not embedded yet' });
    }
    const response: LabelSuggestionsResponse = { suggestions };
    return json(ctx.res, 200, response);
  });

  router.get('/boards/:id/search', async (ctx) => {
    const userId = requireAuth(ctx);
    const boardId = param(ctx, 'id');
    await boardForViewing(userId, boardId);
    if (!env.EMBEDDINGS) {
      return json(ctx.res, 503, { error: 'embeddings are off' });
    }
    const text = (ctx.url.searchParams.get('text') ?? '').trim();
    if (!text || text.length > 200) {
      return json(ctx.res, 400, { error: 'text must be 1 to 200 characters' });
    }
    const sort = parseSortOrDefault(ctx.url.searchParams.get('sort'));
    const response: MeaningResponse = {
      matches: await searchText(boardId, text, sort, meaningLimit(ctx)),
    };
    return json(ctx.res, 200, response);
  });

  // POST /boards/:id/imports {path} and GET /boards/:id/imports/:importId
  // (CONTEXT.md "Folder import"): fill a board from a folder on the
  // server's disk, under a root the operator allowed. Anyone who may upload
  // to the board may import; the roots are what bound it.
  router.post('/boards/:id/imports', async (ctx) => {
    const userId = requireAuth(ctx);
    const boardId = param(ctx, 'id');
    await boardForUploading(userId, boardId);
    const body = (await readJsonBody(ctx.req)) as
      | Partial<StartFolderImportRequest>
      | undefined;
    if (typeof body?.path !== 'string' || !body.path.trim()) {
      return json(ctx.res, 400, { error: 'path is required' });
    }
    try {
      const started: FolderImport = await startFolderImport(
        boardId,
        userId,
        body.path,
      );
      return json(ctx.res, 202, started);
    } catch (err) {
      if (err instanceof ImportRefused) {
        return json(ctx.res, err.status, { error: err.message });
      }
      throw err;
    }
  });

  router.get('/boards/:id/imports/:importId', async (ctx) => {
    const userId = requireAuth(ctx);
    const boardId = param(ctx, 'id');
    await boardForViewing(userId, boardId);
    const found: FolderImport | null = await folderImport(
      boardId,
      param(ctx, 'importId'),
    );
    if (!found) return json(ctx.res, 404, { error: 'no such import' });
    return json(ctx.res, 200, found);
  });
}
