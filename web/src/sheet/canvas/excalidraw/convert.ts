import { arrowheadsFor } from '@digsite/shared';
// The one file that turns an Excalidraw element into ours and back, and the
// one file that knows how to build a brand-new region or edge out of the
// product's own facts (an image id, a rect, a label). Every other function
// in `canvas/excalidraw/` either calls into here or talks to the imperative
// API directly; nothing outside `canvas/` imports any of this.
import {
  CaptureUpdateAction,
  FONT_FAMILY,
  convertToExcalidrawElements,
  newElementWith,
  reconcileElements,
  restoreElements,
} from '@excalidraw/excalidraw';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type {
  AppState,
  ExcalidrawImperativeAPI,
} from '@excalidraw/excalidraw/types';
import type {
  Arrowhead,
  Binding,
  BoundElementRef,
  NewEdgeOp,
  NewRegionOp,
  PatchOp,
  Rect,
  RemoveOp,
  SceneElement,
  UpdateOp,
  Viewport,
} from '../types.ts';

// research/excalidraw/packages/common/src/constants.ts
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 30;
const FIT_PADDING = 48; // screen px of breathing room around the fitted box

// -- element <-> SceneElement, one field at a time (round-tripped by
// web/test/canvas.test.ts) -------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: reading the handful of fields that exist on some element variants and not others; Excalidraw's own union is not worth narrowing by hand for an internal cast
type Wide = any;

export function toSceneElement(el: ExcalidrawElement): SceneElement {
  const w = el as Wide;
  return {
    id: el.id,
    type: el.type,
    version: el.version,
    versionNonce: w.versionNonce ?? 0,
    updated: w.updated ?? Date.now(),
    isDeleted: el.isDeleted,
    x: el.x,
    y: el.y,
    width: el.width,
    height: el.height,
    customData: w.customData,
    groupIds: w.groupIds ?? [],
    boundElements: w.boundElements ?? null,
    startBinding: (w.startBinding as Binding | null) ?? null,
    endBinding: (w.endBinding as Binding | null) ?? null,
    points: w.points ?? [],
    startArrowhead: (w.startArrowhead as Arrowhead) ?? null,
    endArrowhead: (w.endArrowhead as Arrowhead) ?? null,
    text: w.type === 'text' ? (w.text as string) : undefined,
  };
}

export function toSceneElements(
  els: readonly ExcalidrawElement[],
): SceneElement[] {
  return els.map(toSceneElement);
}

/** The inverse projection: every SETTABLE field of `changes` mapped onto
 * `newElementWith`'s patch shape. Only fields `UpdateOp` ever carries. */
function excalidrawPatch(
  changes: UpdateOp['changes'],
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const key of [
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
    'text',
  ] as const) {
    if (key in changes) patch[key] = (changes as Wide)[key];
  }
  return patch;
}

// -- building a brand-new region or edge -----------------------------------
// convertToExcalidrawElements fills every Excalidraw-internal default it
// isn't given (seed, versionNonce, angle, roundness, ...); the visual ones
// this app cares about — plain fill/stroke, no sketchiness, a sans label —
// are set explicitly on every skeleton below rather than left to
// `currentItem*` app defaults, which only seed elements drawn through
// Excalidraw's OWN tools (nothing here is one).
//
// `id` is the caller's (tools.ts's `newId()`) — but the installed 0.18.1
// silently IGNORES a supplied skeleton `id` and generates its own (checked
// against the running package, not assumed from docs), so `remapContainerId`
// renames the container it built back to the id the caller already committed
// to (and handed to `apply`'s caller as the new element's id) and repoints
// its bound text's `containerId` to match — the text element keeps its own
// generated id, which nothing outside this function ever reads.

const PLAIN_STYLE = {
  roughness: 0,
  strokeStyle: 'solid',
  fillStyle: 'solid',
} as const;

// Match sheet.css's `--region-stroke`/`--edge-stroke` tokens. A CSS custom
// property can't reach an Excalidraw element's own `strokeColor` (a plain
// hex string baked into the element, not read from the page's stylesheet at
// paint time), so the two are kept in sync by eye rather than by a shared
// binding — change one, change the other.
const REGION_STROKE = '#1971c2';
const EDGE_STROKE = '#2f9e44';

/** The element with no `containerId` (the shape itself, never its bound
 * text) is renamed to `id`; whatever bound text points at its old id via
 * `containerId` is repointed to match. */
function remapContainerId(
  built: ExcalidrawElement[],
  id: string,
): ExcalidrawElement[] {
  const container = built.find((e) => !(e as Wide).containerId);
  if (!container || container.id === id) return built;
  const oldId = container.id;
  return built.map((e) => {
    if (e === container) return { ...e, id } as ExcalidrawElement;
    if ((e as Wide).containerId === oldId) {
      return { ...e, containerId: id } as ExcalidrawElement;
    }
    return e;
  });
}

function buildRegion(op: NewRegionOp): ExcalidrawElement[] {
  const skeleton = convertToExcalidrawElements([
    {
      type: 'rectangle',
      x: op.rect.x,
      y: op.rect.y,
      width: op.rect.width,
      height: op.rect.height,
      groupIds: [op.groupId],
      backgroundColor: 'transparent',
      strokeColor: REGION_STROKE,
      ...PLAIN_STYLE,
      customData: {
        kind: 'region',
        imageId: op.imageId,
        label: op.label,
        properties: op.properties,
      },
      label: op.label
        ? {
            text: op.label,
            width: Math.max(40, op.rect.width),
            autoResize: false,
            fontFamily: FONT_FAMILY.Helvetica,
          }
        : undefined,
    } as Wide,
  ]) as ExcalidrawElement[];
  const built = remapContainerId(skeleton, op.id);

  // convertToExcalidrawElements' bound-text fitting can still grow the
  // container to fit wrapped text (research/excalidraw's textElement.ts:
  // growY is unconditional on container height, autoResize only fixes
  // width) — force the container back to the rect the fraction demands,
  // every time, so drawing never depends on what the label measured to.
  const container = built.find((e) => e.id === op.id);
  if (
    container &&
    (container.width !== op.rect.width || container.height !== op.rect.height)
  ) {
    return built.map((e) =>
      e === container
        ? newElementWith(e, { width: op.rect.width, height: op.rect.height })
        : e,
    );
  }
  return built;
}

function centerOf(r: { x: number; y: number; width: number; height: number }) {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

function buildEdge(op: NewEdgeOp): ExcalidrawElement[] {
  const a = centerOf(op.fromRect);
  const b = centerOf(op.toRect);
  const heads = arrowheadsFor(op.direction);
  const skeleton = convertToExcalidrawElements([
    {
      type: 'arrow',
      x: a.x,
      y: a.y,
      points: [
        [0, 0],
        [b.x - a.x, b.y - a.y],
      ],
      startArrowhead: heads.startArrowhead,
      endArrowhead: heads.endArrowhead,
      strokeColor: EDGE_STROKE,
      ...PLAIN_STYLE,
      customData: {
        kind: 'edge',
        relation: op.relation,
        direction: op.direction,
        properties: op.properties,
      },
      label: op.relation
        ? { text: op.relation, fontFamily: FONT_FAMILY.Helvetica }
        : undefined,
    } as Wide,
  ]) as ExcalidrawElement[];
  const built = remapContainerId(skeleton, op.id);
  const arrow = built.find((e) => e.id === op.id) as Wide;
  if (arrow) {
    arrow.startBinding = {
      elementId: op.fromId,
      fixedPoint: [0.5, 0.5],
      mode: 'orbit',
    };
    arrow.endBinding = {
      elementId: op.toId,
      fixedPoint: [0.5, 0.5],
      mode: 'orbit',
    };
  }
  return built;
}

/** Applies every op in `patch`, in order, against `current`. Pure: returns
 * the next element list, does not touch the imperative API — Canvas.tsx is
 * the only caller, and the only place that turns the result into a real
 * `updateScene`. */
export function applyPatch(
  patch: PatchOp[],
  current: readonly ExcalidrawElement[],
): ExcalidrawElement[] {
  let elements = current.slice();

  function bindArrow(elementId: string, arrowId: string) {
    elements = elements.map((e) => {
      if (e.id !== elementId) return e;
      const w = e as Wide;
      const bound: BoundElementRef[] = w.boundElements ?? [];
      return newElementWith(e, {
        boundElements: [...bound, { id: arrowId, type: 'arrow' }],
      } as Wide);
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
      const patchFields = excalidrawPatch(op.changes);
      elements = elements.map((e) =>
        e.id === op.id ? newElementWith(e, patchFields as Wide) : e,
      );
      continue;
    }
    if (op.op === 'remove') {
      const ids = new Set((op as RemoveOp).ids);
      elements = elements.map((e) =>
        ids.has(e.id) && !e.isDeleted
          ? newElementWith(e, { isDeleted: true })
          : e,
      );
    }
  }

  return elements;
}

/** Array order must agree with fractional-index order before Excalidraw's
 * `syncInvalidIndices` sees it: an index that is not greater than its array
 * predecessor's is "invalid" and gets reassigned, which is how an arrow
 * stored as `b0c` came back as `b0z`, past its own label. Elements without
 * an index are the seeded images and containers made before indices were
 * kept; they go FIRST, in their own order, so images stay at the bottom of
 * the z-order and a container precedes the label that was indexed later.
 * Pure. */
export function orderByIndex<T extends { index?: string | null }>(
  elements: T[],
): T[] {
  const indexed = elements
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.index != null);
  const bare = elements.filter((e) => e.index == null);
  indexed.sort((a, b) => {
    const ai = a.e.index as string;
    const bi = b.e.index as string;
    return ai < bi ? -1 : ai > bi ? 1 : a.i - b.i;
  });
  return [...bare, ...indexed.map(({ e }) => e)];
}

/** Excalidraw's invariant: a bound text sorts after its container by
 * fractional index, and its dev build throws `InvalidFractionalIndexError`
 * on a snapshot that breaks it. A persisted scene can (a server merge once
 * ordered by id). Move every offending text right after its container and
 * drop its index, so `restoreElements`' index sync assigns a fresh one in
 * that position. Pure; the input is the server's JSON, so fields are read
 * defensively. */
export function repairBoundTextOrder<
  T extends {
    id: string;
    containerId?: string | null;
    index?: string | null;
    boundElements?: { id: string; type: string }[] | null;
  },
>(elements: T[]): T[] {
  const byId = new Map(elements.map((e) => [e.id, e]));
  // A label knows its container by `containerId`, or only the container
  // knows it, through `boundElements`; both spellings occur in stored scenes.
  const containerOf = new Map<string, T>();
  for (const el of elements) {
    if (el.containerId && byId.has(el.containerId))
      containerOf.set(el.id, byId.get(el.containerId) as T);
    for (const b of el.boundElements ?? []) {
      if (b.type === 'text' && byId.has(b.id) && !containerOf.has(b.id))
        containerOf.set(b.id, el);
    }
  }
  const isBefore = (text: T, container: T) =>
    text.index == null ||
    container.index == null ||
    text.index <= container.index;
  const moved = new Set<string>();
  for (const [textId, container] of containerOf) {
    const text = byId.get(textId) as T;
    if (isBefore(text, container)) moved.add(textId);
  }
  const out: T[] = [];
  for (const el of elements) {
    if (moved.has(el.id)) continue;
    out.push(el);
    for (const [textId, container] of containerOf) {
      if (container.id === el.id && moved.has(textId))
        out.push({ ...(byId.get(textId) as T), index: null });
    }
  }
  return out;
}

/** The wire boundary: a raw snapshot (the 'joined' payload, freshly seeded
 * and missing Excalidraw's internal defaults, or a 'scene' delta, already
 * full) restored then reconciled against the live scene. One path for
 * both — `restoreElements` is safe to run on an already-full element. */
export function reconcileRemote(
  raw: unknown[],
  current: readonly ExcalidrawElement[],
  appState: AppState,
): ExcalidrawElement[] {
  const restored = restoreElements(
    // biome-ignore lint/suspicious/noExplicitAny: raw is the server's JSON
    repairBoundTextOrder(orderByIndex(raw as any[])) as any,
    null,
  ) as unknown as ExcalidrawElement[];
  return reconcileElements(
    current as Wide,
    restored as Wide,
    appState,
  ) as unknown as ExcalidrawElement[];
}

/** The scroll/zoom that fits `rects`' union in a `containerWidth` x
 * `containerHeight` viewport, `FIT_PADDING` screen px of margin on every
 * side — `sceneCoordsToViewportCoords`'s own formula
 * (screenX = (sceneX + scrollX) * zoom + offsetLeft, offset 0 here) run
 * backwards. An empty `rects` returns the viewport unchanged: nothing to
 * fit is not this function's decision to make. */
export function fitViewport(
  rects: readonly Rect[],
  containerWidth: number,
  containerHeight: number,
  current: Viewport,
): Viewport {
  if (!rects.length || containerWidth <= 0 || containerHeight <= 0) {
    return current;
  }
  const minX = Math.min(...rects.map((r) => r.x));
  const minY = Math.min(...rects.map((r) => r.y));
  const maxX = Math.max(...rects.map((r) => r.x + r.width));
  const maxY = Math.max(...rects.map((r) => r.y + r.height));
  const boxW = Math.max(1, maxX - minX);
  const boxH = Math.max(1, maxY - minY);
  const availW = Math.max(1, containerWidth - FIT_PADDING * 2);
  const availH = Math.max(1, containerHeight - FIT_PADDING * 2);
  const zoom = Math.min(
    MAX_ZOOM,
    Math.max(MIN_ZOOM, Math.min(availW / boxW, availH / boxH)),
  );
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return {
    zoom,
    scrollX: containerWidth / 2 / zoom - cx,
    scrollY: containerHeight / 2 / zoom - cy,
  };
}

/** Zoom by `factor` (>1 in, <1 out), holding the scene point under
 * `(anchorX, anchorY)` (screen px, container-relative) fixed — the same
 * contract `zoomAt` documents elsewhere in this codebase
 * (image-graph/tldraw-mcp's camera arithmetic): the point under the anchor
 * stays under it after the clamp. */
export function zoomBy(
  current: Viewport,
  factor: number,
  anchorX: number,
  anchorY: number,
): Viewport {
  const nextZoom = Math.min(
    MAX_ZOOM,
    Math.max(MIN_ZOOM, current.zoom * factor),
  );
  if (nextZoom === current.zoom) return current;
  const sceneX = anchorX / current.zoom - current.scrollX;
  const sceneY = anchorY / current.zoom - current.scrollY;
  return {
    zoom: nextZoom,
    scrollX: anchorX / nextZoom - sceneX,
    scrollY: anchorY / nextZoom - sceneY,
  };
}

export function applyToApi(
  api: ExcalidrawImperativeAPI,
  elements: ExcalidrawElement[],
  history: boolean,
): void {
  api.updateScene({
    elements,
    captureUpdate: history
      ? CaptureUpdateAction.IMMEDIATELY
      : CaptureUpdateAction.NEVER,
  });
}
