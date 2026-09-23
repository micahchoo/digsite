// window.__digsite: the sheet's whole public surface, so e2e (and the smoke
// script) drive functions, not pixels (docs/design.md "web/"). Every
// function here reads the LIVE scene through `getHandle()` at call time —
// never a cached element list — which is what keeps `copyForeign` honest per
// ../../.claude/rules/foreign-never-in-scene.md: "Never read the overlay's
// last-rendered rect". Talks to the canvas only through `CanvasHandle` and
// `SceneElement` (canvas/types.ts) through the canvas contract.
import {
  type Direction,
  type Fraction,
  type PropertyValue,
  type Rect,
  arrowheadsFor,
  clampFraction,
  dataOf,
  fromFraction,
  imageGroupId,
  toFraction,
} from '@digsite/shared';
// Aliased: this file's convention is `const handle = getHandle()` everywhere
// below for the canvas's imperative handle; `httpApi` is the one HTTP call
// (rename) among all these scene-only tools.
import { api as httpApi } from '../lib/api.ts';
import { notifySheetsChanged } from '../lib/sheetEvents.ts';
import type { CanvasHandle, PatchOp, SceneElement } from './canvas/types.ts';
import { isDangling } from './dangling.ts';
import { type Tool, rectFromDrag } from './gestures.ts';
import { hitAt } from './hit.ts';
import { truncateLabel } from './labels.ts';
import { type ForeignShape, foreignCopyRect } from './overlay/screen.ts';
import type { RoomStatus } from './room.ts';

/** `room.ts`'s own status shape, under the name this file's public surface
 * (`window.__digsite.syncStatus`) has always used. */
export type SyncStatus = RoomStatus;

// Nested, not spread: ForeignShape has its own `kind` ('region' | 'edge'),
// which would silently overwrite a spread `kind: 'foreign'` in an object
// literal (later spread wins). e2e and the smoke script assert
// `getSelected().kind === 'foreign'` on the OUTER discriminant.
export type Selected =
  | { kind: 'foreign'; shape: ForeignShape }
  | { kind: 'own'; elements: SceneElement[] };

/** An edge tools.ts#applyCascade rebound to an image, per the inspector's
 * "dangling" list (docs/phases/2-sheet.md section 5). */
export interface DanglingEdge {
  id: string;
  relation: string;
}

export interface Tools {
  drawRegion: (
    imageId: string,
    fraction: Fraction,
    label?: string,
  ) => string | null;
  connect: (
    fromId: string,
    toId: string,
    relation?: string,
    direction?: Direction,
  ) => string | null;
  moveImage: (imageId: string, dx: number, dy: number) => void;
  setRegionRect: (id: string, fraction: Partial<Fraction>) => void;
  copyForeign: (foreignShapeId: string) => string | null;
  select: (id: string) => void;
  deleteSelected: () => void;
  getElements: () => SceneElement[];
  getForeign: () => ForeignShape[];
  getSelected: () => Selected | null;
  setProperty: (id: string, key: string, value: PropertyValue) => void;
  removeProperty: (id: string, key: string) => void;
  syncStatus: () => SyncStatus;
  // -- Toolbar + drawing (docs/phases/2-sheet.md section 1) -----------------
  setTool: (tool: Tool) => void;
  getTool: () => Tool;
  /** Drives a region draw in SCENE coords — the real Toolbar/DrawLayer
   * convert a screen drag through the viewport first; this is also
   * `window.__digsite.pointerDraw` for tests. */
  pointerDraw: (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
  ) => string | null;
  /** Two scene points, source then target — `window.__digsite.pointerConnect`. */
  pointerConnect: (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
  ) => string | null;
  // -- dangling (section 5) --------------------------------------------------
  getDangling: () => DanglingEdge[];
  removeDangling: () => number;
  // -- rename (section 6) ---------------------------------------------------
  rename: (name: string) => Promise<void>;
  // -- view: the toolbar's "fit", so a test can bring a shape on screen ------
  zoomToFit: () => void;
}

export interface ToolsDeps {
  getHandle: () => CanvasHandle | null;
  getForeignShapes: () => ForeignShape[];
  getSelectedForeignId: () => string | null;
  setSelectedForeign: (id: string | null) => void;
  getSyncStatus: () => SyncStatus;
  getTool: () => Tool;
  setTool: (tool: Tool) => void;
  getSheetId: () => string;
  onRenamed: (name: string) => void;
}

function newId(): string {
  return crypto.randomUUID();
}

function rectOf(el: SceneElement): Rect {
  return { x: el.x, y: el.y, width: el.width, height: el.height };
}

function liveImageElements(handle: CanvasHandle): Map<string, SceneElement> {
  const map = new Map<string, SceneElement>();
  for (const el of handle.elements()) {
    if (el.isDeleted) continue;
    const data = dataOf(el);
    if (data?.kind === 'image') map.set(data.imageId, el);
  }
  return map;
}

export function createTools(deps: ToolsDeps): Tools {
  const {
    getHandle,
    getForeignShapes,
    getSelectedForeignId,
    setSelectedForeign,
    getSyncStatus,
    getTool: getToolExternal,
    setTool: setToolExternal,
    getSheetId,
    onRenamed,
  } = deps;

  function drawRegion(
    imageId: string,
    fraction: Fraction,
    label = '',
  ): string | null {
    const handle = getHandle();
    if (!handle) return null;
    const imgEl = liveImageElements(handle).get(imageId);
    if (!imgEl) return null;
    const rect = fromFraction(clampFraction(fraction), rectOf(imgEl));
    const id = newId();
    handle.apply([
      {
        op: 'addRegion',
        id,
        imageId,
        groupId: imageGroupId(imageId),
        rect,
        label,
        properties: {},
      },
    ]);
    return id;
  }

  // Direction defaults to 'forward' (docs/design.md "web/" § "The sheet
  // page": "direction defaulting to forward") — the release of a plain
  // click-click edge draw, before the owner ever opens the inspector.
  function connect(
    fromId: string,
    toId: string,
    relation = '',
    direction: Direction = 'forward',
  ): string | null {
    const handle = getHandle();
    if (!handle) return null;
    const current = handle.elements();
    const fromEl = current.find((e) => e.id === fromId && !e.isDeleted);
    const toEl = current.find((e) => e.id === toId && !e.isDeleted);
    if (!fromEl || !toEl) return null;
    const id = newId();
    handle.apply([
      {
        op: 'addEdge',
        id,
        fromId,
        toId,
        fromRect: rectOf(fromEl),
        toRect: rectOf(toEl),
        relation,
        direction,
        properties: {},
      },
    ]);
    return id;
  }

  function moveImage(imageId: string, dx: number, dy: number): void {
    const handle = getHandle();
    if (!handle) return;
    const groupId = imageGroupId(imageId);
    const ops: PatchOp[] = [];
    for (const e of handle.elements()) {
      if (e.isDeleted) continue;
      const data = dataOf(e);
      const inGroup =
        (data?.kind === 'image' && data.imageId === imageId) ||
        e.groupIds.includes(groupId);
      if (!inGroup) continue;
      ops.push({
        op: 'update',
        id: e.id,
        changes: { x: e.x + dx, y: e.y + dy },
      });
    }
    if (ops.length) handle.apply(ops);
  }

  function setRegionRect(id: string, fraction: Partial<Fraction>): void {
    const handle = getHandle();
    if (!handle) return;
    const current = handle.elements();
    const region = current.find((e) => e.id === id && !e.isDeleted);
    if (!region) return;
    const data = dataOf(region);
    if (data?.kind !== 'region') return;
    const imgEl = liveImageElements(handle).get(data.imageId);
    if (!imgEl) return;
    const existing = toFraction(rectOf(region), rectOf(imgEl));
    const merged = clampFraction({ ...existing, ...fraction });
    const rect = fromFraction(merged, rectOf(imgEl));
    handle.apply([{ op: 'update', id, changes: rect }]);
  }

  function copyForeign(foreignShapeId: string): string | null {
    const handle = getHandle();
    if (!handle) return null;
    const shape = getForeignShapes().find((s) => s.id === foreignShapeId);
    if (!shape) return null;

    if (shape.kind === 'region') {
      const imgEl = liveImageElements(handle).get(shape.row.imageId);
      if (!imgEl) return null;
      const rect = foreignCopyRect(shape.row, rectOf(imgEl)); // recomputed NOW
      const id = newId();
      handle.apply([
        {
          op: 'addRegion',
          id,
          imageId: shape.row.imageId,
          groupId: imageGroupId(shape.row.imageId),
          rect,
          label: shape.row.label,
          properties: shape.row.properties,
        },
      ]);
      return id;
    }

    // A foreign edge copies only when both ends are plain image endpoints —
    // this sheet always holds that image (Foreign already filters to it).
    // An end bound to a foreign REGION has nothing on this sheet to bind to
    // unless that region was copied first, so it is not copyable here.
    if (shape.row.source.regionSourceId || shape.row.target.regionSourceId) {
      return null;
    }
    return connect(
      shape.row.source.imageId,
      shape.row.target.imageId,
      shape.row.relation,
      shape.row.direction,
    );
  }

  function select(id: string): void {
    const handle = getHandle();
    if (!handle) return;
    const foreign = getForeignShapes().find((s) => s.id === id);
    if (foreign) {
      setSelectedForeign(id);
      handle.select([]);
      return;
    }
    setSelectedForeign(null);
    handle.select([id]);
  }

  function getElements(): SceneElement[] {
    return (
      getHandle()
        ?.elements()
        .filter((e) => !e.isDeleted) ?? []
    );
  }

  function getForeign(): ForeignShape[] {
    return getForeignShapes();
  }

  function getSelected(): Selected | null {
    const handle = getHandle();
    if (!handle) return null;
    const selId = getSelectedForeignId();
    if (selId) {
      const shape = getForeignShapes().find((s) => s.id === selId);
      if (shape) return { kind: 'foreign', shape };
    }
    const ids = new Set(handle.selectedIds());
    const selected = handle
      .elements()
      .filter((e) => !e.isDeleted && ids.has(e.id));
    if (!selected.length) return null;
    return { kind: 'own', elements: selected };
  }

  function setProperty(id: string, key: string, value: PropertyValue): void {
    const handle = getHandle();
    if (!handle) return;
    const current = handle.elements();
    const el = current.find((e) => e.id === id && !e.isDeleted);
    if (!el) return;
    const data = dataOf(el);
    if (!data || data.kind === 'image') return;

    if (data.kind === 'edge' && key === 'direction') {
      const direction = value as Direction;
      const heads = arrowheadsFor(direction);
      handle.apply([
        {
          op: 'update',
          id,
          changes: { customData: { ...data, direction }, ...heads },
        },
      ]);
      return;
    }

    if (
      (data.kind === 'region' && key === 'label') ||
      (data.kind === 'edge' && key === 'relation')
    ) {
      const boundTextId = el.boundElements?.find((b) => b.type === 'text')?.id;
      // The full string is the data (customData.label/relation); the bound
      // text on the canvas is a truncated, ellipsised VIEW of it — same
      // split as drawRegion, so editing a label never regrows the region.
      const displayText =
        data.kind === 'region' ? truncateLabel(String(value)) : String(value);
      const ops: PatchOp[] = [
        {
          op: 'update',
          id,
          changes: { customData: { ...data, [key]: value } },
        },
      ];
      if (boundTextId) {
        ops.push({
          op: 'update',
          id: boundTextId,
          changes: { text: displayText },
        });
      }
      handle.apply(ops);
      return;
    }

    const properties = { ...data.properties, [key]: value };
    handle.apply([
      { op: 'update', id, changes: { customData: { ...data, properties } } },
    ]);
  }

  function removeProperty(id: string, key: string): void {
    const handle = getHandle();
    if (!handle) return;
    const current = handle.elements();
    const el = current.find((e) => e.id === id && !e.isDeleted);
    if (!el) return;
    const data = dataOf(el);
    if (!data || data.kind === 'image') return;
    const properties = { ...data.properties };
    delete properties[key];
    handle.apply([
      { op: 'update', id, changes: { customData: { ...data, properties } } },
    ]);
  }

  function syncStatus(): SyncStatus {
    return getSyncStatus();
  }

  function deleteSelected(): void {
    const handle = getHandle();
    if (!handle) return;
    const ids = handle.selectedIds();
    if (!ids.length) return;
    handle.apply([{ op: 'remove', ids }]);
    setSelectedForeign(null);
  }

  // -- toolbar --------------------------------------------------------------

  function setTool(tool: Tool): void {
    setToolExternal(tool);
  }

  function getTool(): Tool {
    return getToolExternal();
  }

  // -- drawing from scene coordinates — the real Toolbar/DrawLayer convert
  // a screen drag through the viewport before calling these; the test hooks
  // call them directly. --------------------------------------------------

  function pointerDraw(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
  ): string | null {
    const handle = getHandle();
    if (!handle) return null;
    const hit = hitAt({ x: x0, y: y0 }, handle.elements());
    if (!hit || hit.kind !== 'image') return null;
    const imgEl = liveImageElements(handle).get(hit.imageId);
    if (!imgEl) return null;
    const dragRect = rectFromDrag({ x: x0, y: y0 }, { x: x1, y: y1 });
    const fraction = clampFraction(toFraction(dragRect, rectOf(imgEl)));
    return drawRegion(hit.imageId, fraction);
  }

  function pointerConnect(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
  ): string | null {
    const handle = getHandle();
    if (!handle) return null;
    const elements = handle.elements();
    const fromHit = hitAt({ x: x0, y: y0 }, elements);
    const toHit = hitAt({ x: x1, y: y1 }, elements);
    if (!fromHit || !toHit || fromHit.id === toHit.id) return null;
    return connect(fromHit.id, toHit.id);
  }

  // -- dangling ---------------------------------------------------------------

  function getDangling(): DanglingEdge[] {
    const handle = getHandle();
    if (!handle) return [];
    return handle
      .elements()
      .filter((e) => !e.isDeleted)
      .filter(isDangling)
      .map((e) => {
        const data = dataOf(e);
        return {
          id: e.id,
          relation: data?.kind === 'edge' ? data.relation : '',
        };
      });
  }

  function removeDangling(): number {
    const handle = getHandle();
    if (!handle) return 0;
    const ids = handle
      .elements()
      .filter((e) => !e.isDeleted && isDangling(e))
      .map((e) => e.id);
    if (ids.length) handle.apply([{ op: 'remove', ids }]);
    return ids.length;
  }

  // -- rename -----------------------------------------------------------------

  async function rename(name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) return;
    await httpApi.updateSheet(getSheetId(), { name: trimmed });
    onRenamed(trimmed);
    // Slice 2 follow-up (a): the channel column's own sheet name is stale
    // until it refetches — an event, not a poll.
    notifySheetsChanged();
  }

  return {
    drawRegion,
    connect,
    moveImage,
    setRegionRect,
    copyForeign,
    select,
    deleteSelected,
    getElements,
    getForeign,
    getSelected,
    setProperty,
    removeProperty,
    syncStatus,
    setTool,
    getTool,
    pointerDraw,
    pointerConnect,
    getDangling,
    removeDangling,
    rename,
    zoomToFit: () => getHandle()?.zoomToFit(),
  };
}

declare global {
  interface Window {
    __digsite: Tools;
  }
}
