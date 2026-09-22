// Building a brand-new region or edge out of the product's own facts, and
// applying a `ScenePatch` — the native adapter's answer to
// `../excalidraw/convert.ts`'s `buildRegion`/`buildEdge`/`applyPatch`, over
// plain `SceneElement` objects instead of Excalidraw's skeleton-building
// helpers. Pure: no canvas, no DOM.
import { arrowheadsFor } from '@digsite/shared';
import { truncateLabel } from '../../labels.ts';
import type {
  BoundElementRef,
  NewEdgeOp,
  NewRegionOp,
  PatchOp,
  RemoveOp,
  SceneElement,
  UpdateOp,
} from '../types.ts';
import type { HistoryEntry } from './history.ts';

export function randomVersionNonce(): number {
  return Math.floor(Math.random() * 0x7fffffff);
}

function centerOf(r: { x: number; y: number; width: number; height: number }) {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

function bumpedElement(
  base: SceneElement,
  changes: Partial<SceneElement>,
): SceneElement {
  return {
    ...base,
    ...changes,
    version: base.version + 1,
    versionNonce: randomVersionNonce(),
    updated: Date.now(),
  };
}

/** `touch`: bump an element's version past whatever it holds — used when an
 * interactive drag (a move, a resize) has been applying field changes
 * live, without touching version each frame, and now commits one step at
 * pointer-up. */
export function touch(el: SceneElement): SceneElement {
  return bumpedElement(el, {});
}

function buildRegion(op: NewRegionOp): SceneElement[] {
  const now = Date.now();
  const container: SceneElement = {
    id: op.id,
    type: 'rectangle',
    version: 1,
    versionNonce: randomVersionNonce(),
    updated: now,
    isDeleted: false,
    x: op.rect.x,
    y: op.rect.y,
    width: op.rect.width,
    height: op.rect.height,
    groupIds: [op.groupId],
    boundElements: null,
    startBinding: null,
    endBinding: null,
    points: [],
    startArrowhead: null,
    endArrowhead: null,
    customData: {
      kind: 'region',
      imageId: op.imageId,
      label: op.label,
      properties: op.properties,
    },
  };
  if (!op.label) return [container];
  const textId = crypto.randomUUID();
  const text: SceneElement = {
    id: textId,
    type: 'text',
    version: 1,
    versionNonce: randomVersionNonce(),
    updated: now,
    isDeleted: false,
    x: op.rect.x,
    y: op.rect.y,
    width: Math.max(40, op.rect.width),
    height: 16,
    groupIds: [op.groupId],
    boundElements: null,
    startBinding: null,
    endBinding: null,
    points: [],
    startArrowhead: null,
    endArrowhead: null,
    text: truncateLabel(op.label),
  };
  container.boundElements = [{ id: textId, type: 'text' }];
  return [container, text];
}

function buildEdge(op: NewEdgeOp): SceneElement[] {
  const now = Date.now();
  const a = centerOf(op.fromRect);
  const b = centerOf(op.toRect);
  const heads = arrowheadsFor(op.direction);
  const arrow: SceneElement = {
    id: op.id,
    type: 'arrow',
    version: 1,
    versionNonce: randomVersionNonce(),
    updated: now,
    isDeleted: false,
    x: a.x,
    y: a.y,
    width: Math.abs(b.x - a.x) || 1,
    height: Math.abs(b.y - a.y) || 1,
    groupIds: [],
    boundElements: null,
    startBinding: { elementId: op.fromId },
    endBinding: { elementId: op.toId },
    points: [
      [0, 0],
      [b.x - a.x, b.y - a.y],
    ],
    startArrowhead: heads.startArrowhead,
    endArrowhead: heads.endArrowhead,
    customData: {
      kind: 'edge',
      relation: op.relation,
      direction: op.direction,
      properties: op.properties,
    },
  };
  const elements: SceneElement[] = [arrow];
  if (op.relation) {
    const textId = crypto.randomUUID();
    elements.push({
      id: textId,
      type: 'text',
      version: 1,
      versionNonce: randomVersionNonce(),
      updated: now,
      isDeleted: false,
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2,
      width: 80,
      height: 16,
      groupIds: [],
      boundElements: null,
      startBinding: null,
      endBinding: null,
      points: [],
      startArrowhead: null,
      endArrowhead: null,
      text: op.relation,
    });
    arrow.boundElements = [{ id: textId, type: 'text' }];
  }
  return elements;
}

/** Applies every op in `patch`, in order, against `current` — the native
 * mirror of `excalidraw/convert.ts#applyPatch`. Pure; does not retarget
 * bound edges (`scene.ts#retargetEdges` is a separate pass the caller runs
 * after, same as it runs after an interactive drag). */
export function applyPatch(
  patch: PatchOp[],
  current: readonly SceneElement[],
): SceneElement[] {
  let elements = current.slice();

  function bindArrow(elementId: string, arrowId: string) {
    elements = elements.map((e) => {
      if (e.id !== elementId) return e;
      const bound: BoundElementRef[] = e.boundElements
        ? [...e.boundElements]
        : [];
      return {
        ...e,
        boundElements: [...bound, { id: arrowId, type: 'arrow' }],
      };
    });
  }

  for (const op of patch) {
    if (op.op === 'addRegion') {
      elements = [...elements, ...buildRegion(op)];
      continue;
    }
    if (op.op === 'addEdge') {
      elements = [...elements, ...buildEdge(op)];
      bindArrow(op.fromId, op.id);
      bindArrow(op.toId, op.id);
      continue;
    }
    if (op.op === 'update') {
      const u = op as UpdateOp;
      elements = elements.map((e) =>
        e.id === u.id ? bumpedElement(e, u.changes) : e,
      );
      continue;
    }
    if (op.op === 'remove') {
      const ids = new Set((op as RemoveOp).ids);
      elements = elements.map((e) =>
        ids.has(e.id) && !e.isDeleted
          ? bumpedElement(e, { isDeleted: true })
          : e,
      );
    }
  }

  return elements;
}

/** Every id in `next` whose element differs (by reference) from `current` —
 * `applyPatch`/`retargetEdges` both return the SAME reference for an
 * untouched element, so this is a cheap identity diff, not a deep one. */
export function diffForHistory(
  current: readonly SceneElement[],
  next: readonly SceneElement[],
): HistoryEntry[] {
  const beforeById = new Map(current.map((e) => [e.id, e] as const));
  const entries: HistoryEntry[] = [];
  for (const after of next) {
    const before = beforeById.get(after.id) ?? null;
    if (before === after) continue;
    entries.push({ id: after.id, before, after });
  }
  return entries;
}

/** Finalises an interactive drag (a move, a resize): `origin` is the
 * element array as it was at pointer-down, `current` is where the live
 * preview left it (fields updated frame by frame, version left alone).
 * Every touched element is bumped ONE version past `origin`, and the
 * result is one history step — the drag was one gesture, not one step per
 * frame, same as Excalidraw's own undo stack. */
export function finalizeDrag(
  origin: readonly SceneElement[],
  current: readonly SceneElement[],
): { elements: SceneElement[]; entries: HistoryEntry[] } {
  const originById = new Map(origin.map((e) => [e.id, e] as const));
  const entries: HistoryEntry[] = [];
  const elements = current.map((el) => {
    const before = originById.get(el.id) ?? null;
    if (before === el) return el;
    const bumped = touch(el);
    entries.push({ id: el.id, before, after: bumped });
    return bumped;
  });
  return { elements, entries };
}
