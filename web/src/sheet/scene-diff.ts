// The local correction pass Sheet.tsx's `onChange` runs after every
// committed scene change (docs/phases/2-sheet.md section 1): clamp every
// region against its image's CURRENT rect, then the delete cascade +
// dangling rebind (dangling.ts). Pure — no `CanvasHandle`, no React — so
// it's testable the same way clamp.ts/dangling.ts already are; Sheet.tsx
// just applies the ops this returns and stores the elements.
import { dataOf } from '@digsite/shared';
import type { PatchOp, SceneElement } from './canvas/types.ts';
import { clampRegion } from './clamp.ts';
import { applyCascade } from './dangling.ts';

function rectOf(el: SceneElement) {
  return { x: el.x, y: el.y, width: el.width, height: el.height };
}

const DIFF_KEYS = [
  'x',
  'y',
  'width',
  'height',
  'isDeleted',
  'groupIds',
  'boundElements',
  'startBinding',
  'endBinding',
  'points',
  'startArrowhead',
  'endArrowhead',
  'customData',
] as const;

/** Only the fields that actually differ — passing an unchanged object field
 * (e.g. `customData`) still counts as a change to Excalidraw's own
 * `newElementWith` (any object-valued update is treated as possibly
 * different, per its own comment in mutateElement.ts), so a wholesale copy
 * of `after` would bump a version nothing about semantically changed. */
function diffChanges(before: SceneElement, after: SceneElement) {
  const changes: Record<string, unknown> = {};
  for (const key of DIFF_KEYS) {
    const b = before[key];
    const a = after[key];
    if (b === a) continue;
    if (
      typeof a === 'object' &&
      a !== null &&
      JSON.stringify(a) === JSON.stringify(b)
    )
      continue;
    changes[key] = a;
  }
  return changes;
}

export interface Reconciled {
  /** Empty when nothing needed correcting — the caller should skip
   * `apply` entirely rather than send a no-op patch. */
  ops: PatchOp[];
  /** The corrected list, same length and order as `elements` — what the
   * caller's own state should hold, whether or not `ops` is empty. */
  elements: SceneElement[];
}

export function reconcileLocalChange(elements: SceneElement[]): Reconciled {
  const imgByImageId = new Map<string, SceneElement>();
  for (const el of elements) {
    if (el.isDeleted) continue;
    const data = dataOf(el);
    if (data?.kind === 'image') imgByImageId.set(data.imageId, el);
  }

  const afterClamp = elements.map((el) => {
    if (el.isDeleted) return el;
    const data = dataOf(el);
    if (data?.kind !== 'region') return el;
    const img = imgByImageId.get(data.imageId);
    if (!img) return el;
    const corrected = clampRegion(rectOf(el), rectOf(img));
    return corrected ? { ...el, ...corrected } : el;
  });

  const { elements: finalElements } = applyCascade(afterClamp);

  const ops: PatchOp[] = [];
  for (let i = 0; i < finalElements.length; i++) {
    const before = elements[i];
    const after = finalElements[i];
    if (before && after && before !== after) {
      ops.push({
        op: 'update',
        id: after.id,
        changes: diffChanges(before, after),
      });
    }
  }
  return { ops, elements: finalElements };
}
