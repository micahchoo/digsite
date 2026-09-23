// Copying another sheet's claim here, choosing what travels
// (docs/phases/6-product.md: "geometry always, label, properties (per key),
// and for an edge, its connections"). The copy is an ordinary claim of this
// sheet from the moment it exists and carries nothing about its origin
// (foreign-never-in-scene.md).
//
// Pure: handed the shape, the choice and this sheet's pictures, it returns
// the scene writes, or why it cannot. Before 2026-09-23 a connection copied
// through `connect(imageId, imageId)` while elements are keyed `el-img-…`,
// so copying one did nothing on the real server; and a connection with a
// region at either end could not be copied at all.
import { type EdgeEnd, type Stamp, imageGroupId } from '@digsite/shared';
import type {
  NewEdgeOp,
  NewRegionOp,
  PatchOp,
  SceneElement,
} from './canvas/types.ts';
import { type ForeignShape, foreignCopyRect } from './overlay/screen.ts';

export interface CopyChoice {
  /** A region's label; a connection's relation. */
  label: boolean;
  /** The property keys that travel. */
  properties: readonly string[];
  /** A connection's confidence and note. */
  reasons: boolean;
  /** A connection whose end is a region on the other sheet brings that
   * region along, so it has something here to join. */
  ends: boolean;
}

/** Everything travels: what the copy did before there was a choice. */
export function fullChoice(shape: ForeignShape): CopyChoice {
  return {
    label: true,
    properties: Object.keys(shape.row.properties),
    reasons: true,
    ends: true,
  };
}

export type CopyPlan =
  | { ok: true; id: string; ops: PatchOp[] }
  | { ok: false; reason: string };

type Rect = { x: number; y: number; width: number; height: number };
const rectOf = (el: Rect): Rect => ({
  x: el.x,
  y: el.y,
  width: el.width,
  height: el.height,
});

const picked = (
  properties: Record<string, unknown>,
  keys: readonly string[],
): NewRegionOp['properties'] =>
  Object.fromEntries(
    Object.entries(properties).filter(([k]) => keys.includes(k)),
  ) as NewRegionOp['properties'];

export function planCopy(
  shape: ForeignShape,
  choice: CopyChoice,
  scene: {
    /** This sheet's pictures, by image id. */
    images: ReadonlyMap<string, SceneElement>;
    /** Every foreign shape of this poll, where a connection's region ends
     * are found. */
    shapes: readonly ForeignShape[];
  },
  newId: () => string,
  made?: Stamp,
): CopyPlan {
  const regionOp = (
    row: Extract<ForeignShape, { kind: 'region' }>['row'],
    label: boolean,
    keys: readonly string[],
  ): NewRegionOp | null => {
    const image = scene.images.get(row.imageId);
    if (!image) return null;
    return {
      op: 'addRegion',
      id: newId(),
      imageId: row.imageId,
      groupId: imageGroupId(row.imageId),
      // Recomputed against the picture as it is now, never a cached rect.
      rect: foreignCopyRect(row, rectOf(image)),
      label: label ? row.label : '',
      properties: picked(row.properties, keys),
      ...(made ? { made } : {}),
    };
  };

  if (shape.kind === 'region') {
    const op = regionOp(shape.row, choice.label, choice.properties);
    return op
      ? { ok: true, id: op.id, ops: [op] }
      : { ok: false, reason: 'Its picture is not on this sheet.' };
  }

  const row = shape.row;
  const ops: PatchOp[] = [];
  const endOf = (
    end: EdgeEnd,
    which: 'start' | 'end',
  ): { id: string; rect: Rect } | string => {
    const image = scene.images.get(end.imageId);
    if (!image) return `Its ${which} picture is not on this sheet.`;
    if (!end.regionSourceId) return { id: image.id, rect: rectOf(image) };
    if (!choice.ends)
      return `Its ${which} is a region on ${shape.sheetName}. Copy it with its ends.`;
    const region = scene.shapes.find(
      (s): s is Extract<ForeignShape, { kind: 'region' }> =>
        s.kind === 'region' &&
        s.row.sheetId === row.sheetId &&
        s.row.sourceId === end.regionSourceId,
    );
    if (!region) return `Its ${which} region is gone from ${shape.sheetName}.`;
    // The end region travels whole: without its label it is a box.
    const op = regionOp(region.row, true, Object.keys(region.row.properties));
    if (!op) return `Its ${which} picture is not on this sheet.`;
    ops.push(op);
    return { id: op.id, rect: op.rect };
  };
  const from = endOf(row.source, 'start');
  if (typeof from === 'string') return { ok: false, reason: from };
  const to = endOf(row.target, 'end');
  if (typeof to === 'string') return { ok: false, reason: to };
  const edge: NewEdgeOp = {
    op: 'addEdge',
    id: newId(),
    fromId: from.id,
    toId: to.id,
    fromRect: from.rect,
    toRect: to.rect,
    relation: choice.label ? row.relation : '',
    direction: row.direction,
    properties: picked(row.properties, choice.properties),
    ...(made ? { made } : {}),
    ...(choice.reasons && row.confidence ? { confidence: row.confidence } : {}),
    ...(choice.reasons && row.note ? { note: row.note } : {}),
  };
  ops.push(edge);
  return { ok: true, id: edge.id, ops };
}
