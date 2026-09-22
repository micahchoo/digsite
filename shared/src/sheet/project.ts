// The server turning a snapshot into rows (CONTEXT.md "Projection").
// Ported from ../../../prototype/sheet/server/projection.ts, keyed by
// imageId instead of slot and reading shape through elements.ts#dataOf
// instead of trusting customData raw.

import {
  type EdgeEnd,
  type EdgeRow,
  type RegionRow,
  claimId,
} from './claims.ts';
import { type ElementData, dataOf } from './elements.ts';
import { type Rect, toFraction } from './fractions.ts';

export type SceneElement = {
  id: string;
  version: number;
  versionNonce: number;
  type: string;
  isDeleted?: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  customData?: unknown;
  startBinding?: { elementId: string } | null;
  endBinding?: { elementId: string } | null;
};

function rectOf(el: SceneElement): Rect {
  return { x: el.x, y: el.y, width: el.width, height: el.height };
}

export function project(
  sheetId: string,
  elements: SceneElement[],
): { regions: RegionRow[]; edges: EdgeRow[]; unresolved: number } {
  const byId = new Map(elements.map((e) => [e.id, e]));

  const dataById = new Map<string, ElementData>();
  const imagesByImageId = new Map<string, SceneElement>();
  for (const el of elements) {
    if (el.isDeleted) continue;
    const data = dataOf(el);
    if (!data) continue;
    dataById.set(el.id, data);
    if (data.kind === 'image') imagesByImageId.set(data.imageId, el);
  }

  let unresolved = 0;

  const regions: RegionRow[] = [];
  for (const el of elements) {
    if (el.isDeleted) continue;
    const data = dataById.get(el.id);
    if (!data || data.kind !== 'region') continue;
    const image = imagesByImageId.get(data.imageId);
    if (!image) {
      unresolved++;
      continue;
    }
    regions.push({
      id: claimId(sheetId, el.id),
      sheetId,
      sourceId: el.id,
      imageId: data.imageId,
      ...toFraction(rectOf(el), rectOf(image)),
      label: data.label,
      properties: data.properties,
    });
  }

  function resolveEnd(elementId: string | undefined): EdgeEnd | null {
    if (!elementId) return null;
    const bound = byId.get(elementId);
    if (!bound || bound.isDeleted) return null;
    const data = dataById.get(elementId);
    if (!data) return null;
    if (data.kind === 'image') return { imageId: data.imageId };
    if (data.kind === 'region') {
      if (!imagesByImageId.has(data.imageId)) return null;
      return { imageId: data.imageId, regionSourceId: bound.id };
    }
    return null;
  }

  const edges: EdgeRow[] = [];
  for (const el of elements) {
    if (el.isDeleted) continue;
    const data = dataById.get(el.id);
    if (!data || data.kind !== 'edge') continue;
    const source = resolveEnd(el.startBinding?.elementId);
    const target = resolveEnd(el.endBinding?.elementId);
    if (!source || !target) {
      unresolved++;
      continue;
    }
    edges.push({
      id: claimId(sheetId, el.id),
      sheetId,
      sourceId: el.id,
      source,
      target,
      direction: data.direction,
      relation: data.relation,
      properties: data.properties,
    });
  }

  return { regions, edges, unresolved };
}
