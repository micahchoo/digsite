// An import plan's claims (report/import.ts) as one scene patch: every
// region, then every connection bound to its regions or pictures. The
// pictures are already where the report had them (the sheet was made with
// its positions). One patch is one undo, so an import is taken back whole.
// Pure: elements in, ops out.
import {
  type Stamp,
  clampFraction,
  dataOf,
  fromFraction,
  imageGroupId,
} from '@digsite/shared';
import type { ImportEnd, ImportPlan } from '../report/import.ts';
import type { PatchOp, Rect, SceneElement } from './canvas/types.ts';

const rectOf = (el: Rect): Rect => ({
  x: el.x,
  y: el.y,
  width: el.width,
  height: el.height,
});

export function importOps(
  claimsIn: ImportPlan['claims'],
  elements: readonly SceneElement[],
  made: Stamp | undefined,
  newId: () => string,
): { ops: PatchOp[]; claims: number } {
  const ops: PatchOp[] = [];
  const pictures = new Map<string, { id: string; rect: Rect }>();
  for (const el of elements) {
    const d = dataOf(el);
    if (!el.isDeleted && d?.kind === 'image')
      pictures.set(d.imageId, { id: el.id, rect: rectOf(el) });
  }

  const regions = new Map<string, { id: string; rect: Rect }>();
  function region(end: ImportEnd, label: string, properties = {}) {
    const known = end.regionKey ? regions.get(end.regionKey) : undefined;
    if (known) return known;
    const picture = pictures.get(end.imageId);
    if (!picture || !end.fraction) return null;
    const placed = {
      id: newId(),
      rect: fromFraction(clampFraction(end.fraction), picture.rect),
    };
    ops.push({
      op: 'addRegion',
      id: placed.id,
      imageId: end.imageId,
      groupId: imageGroupId(end.imageId),
      rect: placed.rect,
      label,
      properties,
      made,
    });
    if (end.regionKey) regions.set(end.regionKey, placed);
    return placed;
  }

  let claims = 0;
  for (const c of claimsIn) {
    if (c.kind === 'region') {
      const [end] = c.ends;
      if (end && region(end, c.term, c.properties)) claims++;
      continue;
    }
    const [a, b] = c.ends.map((end) =>
      end.fraction ? region(end, end.label ?? '') : pictures.get(end.imageId),
    );
    if (!a || !b) continue;
    ops.push({
      op: 'addEdge',
      id: newId(),
      fromId: a.id,
      toId: b.id,
      fromRect: a.rect,
      toRect: b.rect,
      relation: c.term,
      direction: c.direction,
      properties: c.properties,
      confidence: c.confidence,
      note: c.note,
      made,
    });
    claims++;
  }
  return { ops, claims };
}
