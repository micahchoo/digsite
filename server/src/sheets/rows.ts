// The regions/edges tables' own (snake_case) shape, as `SELECT *` returns
// it, converted to shared/sheet/claims.ts's camelCase wire shape
// (RegionRow/EdgeRow) — one place, shared by routes.ts (a sheet's own +
// foreign rows) and neighbourhood.ts (edges across the board's whole
// graph, CONTEXT.md "The union").
import type { EdgeRow, RegionRow } from '@digsite/shared/sheet/claims';
import type { Direction, Properties } from '@digsite/shared/sheet/elements';

export type RegionDbRow = {
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
export type EdgeDbRow = {
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

export function toRegionRow(r: RegionDbRow): RegionRow {
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

export function toEdgeRow(e: EdgeDbRow): EdgeRow {
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
