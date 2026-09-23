// Delete cascade + dangling edges (docs/phases/2-sheet.md sections 1 and 5).
//
// Two rules, and nothing else touches a binding:
// - deleting an IMAGE deletes its regions (same imageGroupId) and every edge
//   bound to the image or to one of those regions — a group delete.
// - deleting a REGION whose image survives leaves its edge standing: it is
//   rebound to the image (customData.dangling = true, the binding's
//   elementId moved from the region to the image, that endpoint redrawn to
//   the image's centre) rather than deleted. Only "Remove dangling" deletes
//   it, from `tools.ts#removeDangling`.
//
// Pure and DOM-free so it is unit-testable: takes the full element list
// (including tombstones), returns a new list. Sheet.tsx's onChange
// calls this once per change, the same way it already calls the region
// clamp — an unchanged pass returns `changed: false` so the caller can skip
// a no-op updateScene.

import { dataOf, imageGroupId } from '@digsite/shared';

export interface Binding {
  elementId: string;
  [key: string]: unknown;
}

export interface CascadeElement {
  id: string;
  isDeleted?: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  groupIds?: readonly string[];
  boundElements?: readonly { id: string; type: string }[] | null;
  startBinding?: Binding | null;
  endBinding?: Binding | null;
  points?: readonly (readonly [number, number])[];
  startArrowhead?: string | null;
  endArrowhead?: string | null;
  customData?: unknown;
}

export interface CascadeResult<T extends CascadeElement> {
  elements: T[];
  changed: boolean;
}

function centerOf(el: CascadeElement): { x: number; y: number } {
  return { x: el.x + el.width / 2, y: el.y + el.height / 2 };
}

/** The arrow's own current start/end, in scene space — never recomputed
 * from a bound element's rect, since an unaffected end must stay exactly
 * where it visually is. */
function currentEndpoints(el: CascadeElement): {
  start: { x: number; y: number };
  end: { x: number; y: number };
} {
  const pts = el.points ?? [
    [0, 0],
    [0, 0],
  ];
  const first = pts[0] ?? [0, 0];
  const last = pts[pts.length - 1] ?? first;
  return {
    start: { x: el.x + first[0], y: el.y + first[1] },
    end: { x: el.x + last[0], y: el.y + last[1] },
  };
}

function geometryFor(
  start: { x: number; y: number },
  end: { x: number; y: number },
): Pick<CascadeElement, 'x' | 'y' | 'width' | 'height' | 'points'> {
  return {
    x: start.x,
    y: start.y,
    width: Math.abs(end.x - start.x) || 1,
    height: Math.abs(end.y - start.y) || 1,
    points: [
      [0, 0],
      [end.x - start.x, end.y - start.y],
    ],
  };
}

/**
 * Applies both rules once. Idempotent: a scene already cascaded comes back
 * `changed: false` with the same elements.
 */
export function applyCascade<T extends CascadeElement>(
  elements: readonly T[],
): CascadeResult<T> {
  const byId = new Map<string, CascadeElement>(elements.map((e) => [e.id, e]));

  const deletedImageIds = new Set<string>();
  const deletedImageGroups = new Set<string>();
  for (const el of elements) {
    if (!el.isDeleted) continue;
    const data = dataOf(el);
    if (data?.kind !== 'image') continue;
    deletedImageIds.add(el.id);
    deletedImageGroups.add(imageGroupId(data.imageId));
  }

  let imageDeleteChanged = false;
  let afterImageDelete: readonly T[] = elements;

  if (deletedImageIds.size > 0) {
    // Every region in a dead image's group — deleted or not. Group
    // selection can hand this function a region already marked deleted in
    // the same elements array as its image.
    // Skipping those here (as a first cut did) meant an edge bound to that
    // region never matched `regionIdsInDeadGroup` below, and outlived both
    // the image and the region that hit "Delete" together deleted.
    const regionIdsInDeadGroup = new Set<string>();
    for (const el of elements) {
      const data = dataOf(el);
      if (data?.kind !== 'region') continue;
      if ((el.groupIds ?? []).some((g) => deletedImageGroups.has(g))) {
        regionIdsInDeadGroup.add(el.id);
      }
    }

    // A group delete can null an arrow binding to an endpoint before this
    // correction pass sees the change. What survives is the deleted
    // element's `boundElements`, so that is the primary
    // signal; the direct binding-field check stays as a second net for a
    // delete that does NOT go through that action (tools.ts#deleteSelected
    // and #removeDangling call `updateScene` directly, which does not
    // trigger that binding cleanup, so the direct binding check remains a
    // second net.
    const deadArrowIds = new Set<string>();
    for (const el of elements) {
      const data = dataOf(el);
      const isDeadImage = data?.kind === 'image' && deletedImageIds.has(el.id);
      const isDeadRegion =
        data?.kind === 'region' && regionIdsInDeadGroup.has(el.id);
      if (!isDeadImage && !isDeadRegion) continue;
      for (const b of el.boundElements ?? []) {
        if (b.type === 'arrow') deadArrowIds.add(b.id);
      }
    }

    const next = elements.map((el) => {
      if (el.isDeleted) return el;
      const data = dataOf(el);
      if (data?.kind === 'region' && regionIdsInDeadGroup.has(el.id)) {
        imageDeleteChanged = true;
        return { ...el, isDeleted: true };
      }
      if (data?.kind === 'edge') {
        const boundToDead =
          deadArrowIds.has(el.id) ||
          [el.startBinding, el.endBinding].some((b) => {
            if (!b) return false;
            return (
              deletedImageIds.has(b.elementId) ||
              regionIdsInDeadGroup.has(b.elementId)
            );
          });
        if (boundToDead) {
          imageDeleteChanged = true;
          return { ...el, isDeleted: true };
        }
      }
      return el;
    });
    afterImageDelete = next;
  }

  const rebound = rebindDangling(afterImageDelete, byId);
  const changed = imageDeleteChanged || rebound.changed;
  return { elements: rebound.elements as T[], changed };
}

/** Rule two: an edge whose bound region is gone (deleted, its image intact)
 * is rebound to that region's image instead of being deleted. A binding
 * already pointing at an image (a previous rebind, or an edge drawn on an
 * image directly) is left alone. */
function rebindDangling<T extends CascadeElement>(
  elements: readonly T[],
  byId: Map<string, CascadeElement>,
): { elements: T[]; changed: boolean } {
  const imageByGroup = new Map<string, CascadeElement>();
  for (const el of elements) {
    if (el.isDeleted) continue;
    const data = dataOf(el);
    if (data?.kind !== 'image') continue;
    imageByGroup.set(imageGroupId(data.imageId), el);
  }

  function imageForRegion(region: CascadeElement): CascadeElement | null {
    for (const g of region.groupIds ?? []) {
      const img = imageByGroup.get(g);
      if (img) return img;
    }
    return null;
  }

  // A group delete may already have nulled the deleted region's side of an
  // arrow binding. `boundElements` on the region survives that,
  // so a null side on an edge this map lists for is inferred to be the one
  // that used to point at the now-dead region (every edge this app creates
  // always sets both bindings, so a null one is never "just unbound").
  const deadRegionByArrow = new Map<string, CascadeElement>();
  for (const el of elements) {
    if (!el.isDeleted) continue;
    const data = dataOf(el);
    if (data?.kind !== 'region') continue;
    for (const b of el.boundElements ?? []) {
      if (b.type === 'arrow') deadRegionByArrow.set(b.id, el);
    }
  }

  let changed = false;
  const next = elements.map((el) => {
    if (el.isDeleted) return el;
    const data = dataOf(el);
    if (data?.kind !== 'edge') return el;

    const points = currentEndpoints(el);
    let newStart = points.start;
    let newEnd = points.end;
    let startBinding = el.startBinding;
    let endBinding = el.endBinding;
    let startArrowhead = el.startArrowhead;
    let endArrowhead = el.endArrowhead;
    let touched = false;

    for (const side of ['start', 'end'] as const) {
      const binding = side === 'start' ? el.startBinding : el.endBinding;
      let deadRegion: CascadeElement | null = null;
      if (binding) {
        const target = byId.get(binding.elementId);
        if (target?.isDeleted === true && dataOf(target)?.kind === 'region') {
          deadRegion = target;
        } else {
          continue; // alive (region or image), or a deleted image — nothing to do here
        }
      } else {
        // Already nulled by group deletion — infer from boundElements.
        const inferred = deadRegionByArrow.get(el.id);
        if (!inferred) continue;
        deadRegion = inferred;
      }
      const image = imageForRegion(deadRegion);
      if (!image) continue; // the image is gone too; the image-delete pass already removed this edge

      const point = centerOf(image);
      const newBinding: Binding = binding
        ? { ...binding, elementId: image.id }
        : { elementId: image.id, fixedPoint: [0.5, 0.5], mode: 'orbit' };
      // A hollow marker on the rebound end only — docs/phases/2-sheet.md
      // section 5: "drawn to the image's rect with a hollow arrowhead
      // marker". The surviving end keeps whatever direction gave it.
      if (side === 'start') {
        newStart = point;
        startBinding = newBinding;
        startArrowhead = 'triangle_outline';
      } else {
        newEnd = point;
        endBinding = newBinding;
        endArrowhead = 'triangle_outline';
      }
      touched = true;
    }

    if (!touched) return el;
    changed = true;
    const prevData = dataOf(el);
    return {
      ...el,
      ...geometryFor(newStart, newEnd),
      startBinding,
      endBinding,
      startArrowhead,
      endArrowhead,
      customData: { ...(prevData ?? {}), dangling: true },
    };
  });

  return { elements: next, changed };
}

/** True for an edge tools.ts#cascade has rebound to an image after its
 * region end vanished — read by getDangling()/removeDangling() and the
 * inspector's "dangling" list. Never set anywhere else. */
export function isDangling(el: { customData?: unknown }): boolean {
  const d = el.customData;
  return (
    typeof d === 'object' &&
    d !== null &&
    (d as { dangling?: unknown }).dangling === true
  );
}
