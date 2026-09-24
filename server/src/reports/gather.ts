// What a report says (CONTEXT.md "Report"): the claims a scope names, read
// the way every other reader of claims reads them, and nothing written.
//
//   - Claims come from the ROWS, which are the projection of each sheet's
//     snapshot (snapshot.ts writes both in one transaction), so the board
//     union and one sheet are read the same way.
//   - Terms are canonical after the board's aliases, and the term as typed
//     is kept beside it: an alias is applied where claims are read.
//   - Stamps and the dangling mark are read from the snapshot's elements,
//     which the rows do not carry.
//   - A path is `shortestPath`, the same answer as the board's path panel.
//
// The access decision is the route's, before this is called.
import {
  type Aliases,
  REPORT_FORMAT,
  type ReportClaim,
  type ReportData,
  type ReportEnd,
  type ReportImage,
  type ReportPerson,
  type ReportScope,
  type ReportSheet,
  canonicalOf,
  claimId,
  dataOf,
  inReadingOrder,
  shortestPath,
} from '@digsite/shared';
import type { EdgeRow, RegionRow } from '@digsite/shared/sheet/claims';
import { aliasesOf } from '../boards/vocabulary.ts';
import { pool } from '../db/pool.ts';
import { repliesOn } from '../sheets/replies.ts';
import {
  type EdgeDbRow,
  type RegionDbRow,
  toEdgeRow,
  toRegionRow,
} from '../sheets/rows.ts';
import { getSnapshotElements } from '../sheets/snapshot.ts';

export type GatherInput = {
  scope: ReportScope;
  boardId: string;
  boardName: string;
  by: string;
  origin: string;
  title?: string;
};

type SheetRead = ReportSheet & {
  /** The snapshot's live elements, by id. */
  elements: Map<string, SnapshotElement>;
};

type SnapshotElement = {
  id: string;
  isDeleted?: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  customData?: unknown;
};

async function sheetsOf(scope: ReportScope, boardId: string) {
  const one = scope.kind === 'sheet' || scope.kind === 'selection';
  const { rows } = await pool.query<{
    id: string;
    name: string;
    saved_at: Date | null;
  }>(
    `SELECT s.id, s.name, ss.saved_at FROM sheets s
       LEFT JOIN sheet_snapshots ss ON ss.sheet_id = s.id
      WHERE ${one ? 's.id = $1' : 's.board_id = $1'}
      ORDER BY s.created_at, s.id`,
    [one ? scope.sheetId : boardId],
  );
  const out: SheetRead[] = [];
  for (const r of rows) {
    const elements = new Map<string, SnapshotElement>();
    for (const el of (await getSnapshotElements(r.id)) as SnapshotElement[])
      if (el && typeof el.id === 'string') elements.set(el.id, el);
    out.push({
      id: r.id,
      name: r.name,
      savedAt: r.saved_at ? r.saved_at.toISOString() : null,
      elements,
    });
  }
  return out;
}

async function rowsOf(sheetIds: string[]) {
  const [regions, edges] = await Promise.all([
    pool.query<RegionDbRow>(
      'SELECT * FROM regions WHERE sheet_id = ANY($1::uuid[])',
      [sheetIds],
    ),
    pool.query<EdgeDbRow>(
      'SELECT * FROM edges WHERE sheet_id = ANY($1::uuid[])',
      [sheetIds],
    ),
  ]);
  return {
    regions: regions.rows.map(toRegionRow),
    edges: edges.rows.map(toEdgeRow),
  };
}

type ImageDbRow = {
  id: string;
  name: string;
  width: number;
  height: number;
  sha256: string;
  missing: boolean;
  slot: number;
  properties: Record<string, unknown>;
};

async function imagesOf(boardId: string, ids: string[]) {
  const { rows } = await pool.query<ImageDbRow>(
    `SELECT id, name, width, height, sha256, missing, slot, properties
       FROM images WHERE board_id = $1 AND id = ANY($2::uuid[])
      ORDER BY slot`,
    [boardId, ids],
  );
  return rows;
}

const person = (v: unknown): ReportPerson | null => {
  const s = v as { name?: unknown; at?: unknown } | undefined;
  return s && typeof s.name === 'string' && typeof s.at === 'string'
    ? { name: s.name, at: s.at }
    : null;
};

/** The claims a scope names, from all the rows its sheets hold. */
function chosen(
  scope: ReportScope,
  rows: { regions: RegionRow[]; edges: EdgeRow[] },
  sheets: SheetRead[],
  aliases: Aliases,
): { regions: RegionRow[]; edges: EdgeRow[]; path: string[] | null } {
  switch (scope.kind) {
    case 'sheet':
    case 'board':
      return { ...rows, path: null };
    case 'selection': {
      const ids = new Set(scope.ids);
      const elements = sheets[0]?.elements ?? new Map();
      const pictures = new Set<string>();
      for (const id of ids) {
        const data = dataOf(elements.get(id) ?? {});
        if (data?.kind === 'image') pictures.add(data.imageId);
      }
      return {
        regions: rows.regions.filter(
          (r) => ids.has(r.sourceId) || pictures.has(r.imageId),
        ),
        edges: rows.edges.filter(
          (e) =>
            ids.has(e.sourceId) ||
            (pictures.has(e.source.imageId) && pictures.has(e.target.imageId)),
        ),
        path: null,
      };
    }
    case 'relation': {
      const want = canonicalOf(scope.relation, aliases.relation);
      return {
        regions: [],
        edges: rows.edges.filter(
          (e) => canonicalOf(e.relation, aliases.relation) === want,
        ),
        path: null,
      };
    }
    case 'path': {
      const steps = shortestPath(rows.edges, scope.from, scope.to);
      if (!steps) return { regions: [], edges: [], path: [] };
      const path = [scope.from, ...steps.map((s) => s.to)];
      const pairs = new Set(steps.map((s) => [s.from, s.to].sort().join('|')));
      return {
        regions: [],
        // Every claim on each step's pair, not only the one the search
        // walked: the others are what the step rests on too.
        edges: rows.edges.filter((e) =>
          pairs.has([e.source.imageId, e.target.imageId].sort().join('|')),
        ),
        path,
      };
    }
  }
}

function titleOf(input: GatherInput, sheets: SheetRead[]): string {
  if (input.title?.trim()) return input.title.trim().slice(0, 200);
  const scope = input.scope;
  switch (scope.kind) {
    case 'sheet':
      return sheets[0]?.name ?? 'Sheet';
    case 'selection':
      return `${sheets[0]?.name ?? 'Sheet'}: a selection`;
    case 'board':
      return input.boardName;
    case 'relation':
      return `“${scope.relation}” on ${input.boardName}`;
    case 'path':
      return `A path on ${input.boardName}`;
  }
}

export async function gatherReport(input: GatherInput): Promise<ReportData> {
  const { scope, boardId } = input;
  const [sheets, aliases] = await Promise.all([
    sheetsOf(scope, boardId),
    aliasesOf(boardId),
  ]);
  const sheetIds = sheets.map((s) => s.id);
  const rows = await rowsOf(sheetIds);
  const picked = chosen(scope, rows, sheets, aliases);

  // Every region row by its claim key, for the ends of edges that rest on
  // one; drawn from ALL rows, since an edge may end on a region the scope
  // did not pick.
  const regionByKey = new Map(
    rows.regions.map((r) => [claimId(r.sheetId, r.sourceId), r]),
  );
  const elementOf = (sheetId: string, id: string) =>
    sheets.find((s) => s.id === sheetId)?.elements.get(id);

  const imageIds = new Set<string>();
  for (const r of picked.regions) imageIds.add(r.imageId);
  for (const e of picked.edges) {
    imageIds.add(e.source.imageId);
    imageIds.add(e.target.imageId);
  }
  for (const id of picked.path ?? []) imageIds.add(id);
  // A sheet's report shows every picture on the sheet, claimed or not.
  const sheetScene =
    scope.kind === 'sheet' || scope.kind === 'selection' ? sheets[0] : null;
  const placed = new Map<string, SnapshotElement>();
  for (const el of sheetScene?.elements.values() ?? []) {
    const data = dataOf(el);
    if (el.isDeleted || data?.kind !== 'image') continue;
    placed.set(data.imageId, el);
    if (scope.kind === 'sheet') imageIds.add(data.imageId);
  }
  const imageRows = await imagesOf(boardId, [...imageIds]);
  // Reading order on a sheet; the board's slots elsewhere (already sorted).
  const ordered = sheetScene
    ? [
        ...inReadingOrder(
          imageRows
            .filter((r) => placed.has(r.id))
            .map((r) => ({ ...(placed.get(r.id) as SnapshotElement), row: r })),
        ).map((p) => p.row),
        ...imageRows.filter((r) => !placed.has(r.id)),
      ]
    : imageRows;
  const images: ReportImage[] = ordered.map((r) => ({
    id: r.id,
    name: r.name,
    width: r.width,
    height: r.height,
    sha256: r.sha256,
    missing: r.missing,
    properties: r.properties as ReportImage['properties'],
  }));
  const missing = new Set(images.filter((i) => i.missing).map((i) => i.id));

  const replies = new Map<string, ReportClaim['replies']>();
  for (const sheetId of sheetIds)
    for (const r of await repliesOn(sheetId)) {
      const key = claimId(sheetId, r.elementId);
      const list = replies.get(key) ?? [];
      list.push({ name: r.by.name, at: r.at, text: r.text });
      replies.set(key, list);
    }

  const label = (term: string) => canonicalOf(term, aliases.label);
  const endOf = (end: EdgeRow['source'], sheetId: string): ReportEnd => {
    const region = end.regionSourceId
      ? regionByKey.get(claimId(sheetId, end.regionSourceId))
      : undefined;
    return region
      ? {
          imageId: end.imageId,
          regionKey: region.id,
          label: label(region.label),
          fraction: {
            fx: region.fx,
            fy: region.fy,
            fw: region.fw,
            fh: region.fh,
          },
        }
      : { imageId: end.imageId, regionKey: null, label: null, fraction: null };
  };

  const claims: ReportClaim[] = [];
  for (const e of picked.edges) {
    const el = elementOf(e.sheetId, e.sourceId);
    const data = el?.customData as
      | { made?: unknown; edited?: unknown; dangling?: unknown }
      | undefined;
    const gone = [e.source.imageId, e.target.imageId].some((id) =>
      missing.has(id),
    );
    claims.push({
      key: e.id,
      sheetId: e.sheetId,
      elementId: e.sourceId,
      kind: 'connection',
      term: canonicalOf(e.relation, aliases.relation),
      typed: e.relation,
      direction: e.direction,
      confidence: e.confidence,
      note: e.note,
      properties: e.properties,
      made: person(data?.made),
      edited: person(data?.edited),
      ends: [endOf(e.source, e.sheetId), endOf(e.target, e.sheetId)],
      dangling: gone
        ? 'a picture it joins was removed from the board'
        : data?.dangling === true
          ? 'a region it joined was deleted; it now joins the whole picture'
          : null,
      replies: replies.get(e.id) ?? [],
    });
  }
  for (const r of picked.regions) {
    const data = elementOf(r.sheetId, r.sourceId)?.customData as
      | { made?: unknown; edited?: unknown }
      | undefined;
    claims.push({
      key: r.id,
      sheetId: r.sheetId,
      elementId: r.sourceId,
      kind: 'region',
      term: label(r.label),
      typed: r.label,
      direction: null,
      confidence: null,
      note: '',
      properties: r.properties,
      made: person(data?.made),
      edited: person(data?.edited),
      ends: [
        {
          imageId: r.imageId,
          regionKey: r.id,
          label: label(r.label),
          fraction: { fx: r.fx, fy: r.fy, fw: r.fw, fh: r.fh },
        },
      ],
      dangling: missing.has(r.imageId)
        ? 'its picture was removed from the board'
        : null,
      replies: replies.get(r.id) ?? [],
    });
  }

  // Only the sheets something came from, so a board report does not list
  // every empty sheet; a one-sheet scope always names its sheet.
  const speaking = new Set(claims.map((c) => c.sheetId));
  const reportSheets = sheets
    .filter((s) => sheetScene?.id === s.id || speaking.has(s.id))
    .map(({ id, name, savedAt }) => ({ id, name, savedAt }));

  return {
    format: REPORT_FORMAT,
    id: null,
    title: titleOf(input, sheets),
    scope,
    board: { id: boardId, name: input.boardName },
    by: input.by,
    at: new Date().toISOString(),
    origin: input.origin,
    sheets: reportSheets,
    images,
    claims,
    aliases,
    scene: sheetScene
      ? {
          sheetId: sheetScene.id,
          elements: [...sheetScene.elements.values()].filter(
            (el) => !el.isDeleted,
          ),
        }
      : null,
    path: picked.path,
  };
}
