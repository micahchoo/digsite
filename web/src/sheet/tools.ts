// window.__digsite: the sheet's whole public surface, so e2e (and the smoke
// script) drive functions, not pixels (docs/design.md "web/"). Every
// function here reads the LIVE Excalidraw scene through `getApi()` at call
// time — never a cached element list — which is what keeps `copyForeign`
// honest per ../../.claude/rules/foreign-never-in-scene.md: "Never read the
// overlay's last-rendered rect."
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
import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  newElementWith,
} from '@excalidraw/excalidraw';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
// Aliased: this file's convention is `const api = getApi()` everywhere
// below for the Excalidraw imperative API; `httpApi` is the one HTTP call
// (rename) among all these scene-only tools.
import { api as httpApi } from '../lib/api.ts';
import { isDangling } from './dangling.ts';
import { type Tool, rectFromDrag } from './gestures.ts';
import { hitAt } from './hit.ts';
import { regionLabelWidth, truncateLabel } from './labels.ts';
import { type ForeignShape, foreignCopyRect } from './overlay/screen.ts';

export interface SyncStatus {
  emits: number;
  recvs: number;
  lastEmitAt: number | null;
  lastRecvAt: number | null;
  peers: string[];
}

// Nested, not spread: ForeignShape has its own `kind` ('region' | 'edge'),
// which would silently overwrite a spread `kind: 'foreign'` in an object
// literal (later spread wins). e2e and the smoke script assert
// `getSelected().kind === 'foreign'` on the OUTER discriminant.
export type Selected =
  | { kind: 'foreign'; shape: ForeignShape }
  | { kind: 'own'; elements: ExcalidrawElement[] };

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
  getElements: () => ExcalidrawElement[];
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
}

export interface ToolsDeps {
  getApi: () => ExcalidrawImperativeAPI | null;
  getForeignShapes: () => ForeignShape[];
  getSelectedForeignId: () => string | null;
  setSelectedForeign: (id: string | null) => void;
  getSyncStatus: () => SyncStatus;
  getTool: () => Tool;
  setTool: (tool: Tool) => void;
  getSheetId: () => string;
  onRenamed: (name: string) => void;
}

function rectOf(el: ExcalidrawElement): Rect {
  return { x: el.x, y: el.y, width: el.width, height: el.height };
}

function centerOf(r: Rect): { x: number; y: number } {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

function allElements(api: ExcalidrawImperativeAPI): ExcalidrawElement[] {
  return api.getSceneElementsIncludingDeleted() as unknown as ExcalidrawElement[];
}

function liveImageElements(
  api: ExcalidrawImperativeAPI,
): Map<string, ExcalidrawElement> {
  const map = new Map<string, ExcalidrawElement>();
  for (const el of allElements(api)) {
    if (el.isDeleted) continue;
    const data = dataOf(el);
    if (data?.kind === 'image') map.set(data.imageId, el);
  }
  return map;
}

export function createTools(deps: ToolsDeps): Tools {
  const {
    getApi,
    getForeignShapes,
    getSelectedForeignId,
    setSelectedForeign,
    getSyncStatus,
    getTool: getToolExternal,
    setTool: setToolExternal,
    getSheetId,
    onRenamed,
  } = deps;

  function replace(elements: ExcalidrawElement[]) {
    getApi()?.updateScene({
      elements,
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
  }

  function drawRegion(
    imageId: string,
    fraction: Fraction,
    label = '',
  ): string | null {
    const api = getApi();
    if (!api) return null;
    const imgEl = liveImageElements(api).get(imageId);
    if (!imgEl) return null;
    const rect = fromFraction(clampFraction(fraction), rectOf(imgEl));
    const labelWidth = regionLabelWidth(rect);
    const built = convertToExcalidrawElements([
      {
        type: 'rectangle',
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        groupIds: [imageGroupId(imageId)],
        customData: { kind: 'region', imageId, label, properties: {} },
        label: label
          ? { text: truncateLabel(label), width: labelWidth, autoResize: false }
          : undefined,
        // biome-ignore lint/suspicious/noExplicitAny: Excalidraw's skeleton union is not worth narrowing by hand
      } as any,
    ]) as ExcalidrawElement[];
    // convertToExcalidrawElements' bound-text fitting can still grow a
    // container to fit wrapped text (research/excalidraw's textElement.ts:
    // growY is unconditional on container height, autoResize only fixes
    // width) — force the container back to the rect the FRACTION demands,
    // every time, so drawing never depends on what the label measured to.
    // This is the mechanism tools.test.ts's 200-char label case exercises
    // at the fraction level; a real label is exercised in smoke-draw.ts.
    const container = built.find((e) => e.type === 'rectangle');
    const fixedBuilt =
      container &&
      (container.width !== rect.width || container.height !== rect.height)
        ? built.map((e) =>
            e === container
              ? newElementWith(e, { width: rect.width, height: rect.height })
              : e,
          )
        : built;
    replace([...allElements(api), ...fixedBuilt]);
    return fixedBuilt[0]?.id ?? null;
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
    const api = getApi();
    if (!api) return null;
    const current = allElements(api);
    const fromEl = current.find((e) => e.id === fromId && !e.isDeleted);
    const toEl = current.find((e) => e.id === toId && !e.isDeleted);
    if (!fromEl || !toEl) return null;
    const a = centerOf(rectOf(fromEl));
    const b = centerOf(rectOf(toEl));
    const heads = arrowheadsFor(direction);
    const built = convertToExcalidrawElements([
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
        customData: { kind: 'edge', relation, direction, properties: {} },
        label: relation ? { text: relation } : undefined,
        // biome-ignore lint/suspicious/noExplicitAny: Excalidraw's skeleton union is not worth narrowing by hand
      } as any,
    ]) as ExcalidrawElement[];
    const arrow = built.find((e) => e.type === 'arrow');
    if (!arrow) return null;
    // biome-ignore lint/suspicious/noExplicitAny: startBinding/endBinding are set by hand, per docs/design.md
    (arrow as any).startBinding = {
      elementId: fromId,
      fixedPoint: [0.5, 0.5],
      mode: 'orbit',
    };
    // biome-ignore lint/suspicious/noExplicitAny: see above
    (arrow as any).endBinding = {
      elementId: toId,
      fixedPoint: [0.5, 0.5],
      mode: 'orbit',
    };
    const bumpedFrom = newElementWith(fromEl, {
      boundElements: [
        ...(fromEl.boundElements ?? []),
        { id: arrow.id, type: 'arrow' },
      ],
    });
    const bumpedTo = newElementWith(toEl, {
      boundElements: [
        ...(toEl.boundElements ?? []),
        { id: arrow.id, type: 'arrow' },
      ],
    });
    const rest = current.filter((e) => e.id !== fromId && e.id !== toId);
    replace([...rest, bumpedFrom, bumpedTo, ...built]);
    return arrow.id;
  }

  function moveImage(imageId: string, dx: number, dy: number): void {
    const api = getApi();
    if (!api) return;
    const groupId = imageGroupId(imageId);
    const current = allElements(api);
    const updated = current.map((e) => {
      if (e.isDeleted) return e;
      const data = dataOf(e);
      if (data?.kind === 'image' && data.imageId === imageId) {
        return newElementWith(e, { x: e.x + dx, y: e.y + dy });
      }
      if (e.groupIds?.includes(groupId)) {
        return newElementWith(e, { x: e.x + dx, y: e.y + dy });
      }
      return e;
    });
    replace(updated);
  }

  function setRegionRect(id: string, fraction: Partial<Fraction>): void {
    const api = getApi();
    if (!api) return;
    const current = allElements(api);
    const region = current.find((e) => e.id === id && !e.isDeleted);
    if (!region) return;
    const data = dataOf(region);
    if (data?.kind !== 'region') return;
    const imgEl = liveImageElements(api).get(data.imageId);
    if (!imgEl) return;
    const existing = toFraction(rectOf(region), rectOf(imgEl));
    const merged = clampFraction({ ...existing, ...fraction });
    const rect = fromFraction(merged, rectOf(imgEl));
    const updated = current.map((e) =>
      e.id === id ? newElementWith(e, rect) : e,
    );
    replace(updated);
  }

  function copyForeign(foreignShapeId: string): string | null {
    const api = getApi();
    if (!api) return null;
    const shape = getForeignShapes().find((s) => s.id === foreignShapeId);
    if (!shape) return null;

    if (shape.kind === 'region') {
      const imgEl = liveImageElements(api).get(shape.row.imageId);
      if (!imgEl) return null;
      const rect = foreignCopyRect(shape.row, rectOf(imgEl)); // recomputed NOW
      const built = convertToExcalidrawElements([
        {
          type: 'rectangle',
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          groupIds: [imageGroupId(shape.row.imageId)],
          customData: {
            kind: 'region',
            imageId: shape.row.imageId,
            label: shape.row.label,
            properties: shape.row.properties,
          },
          label: shape.row.label ? { text: shape.row.label } : undefined,
          // biome-ignore lint/suspicious/noExplicitAny: Excalidraw's skeleton union is not worth narrowing by hand
        } as any,
      ]) as ExcalidrawElement[];
      replace([...allElements(api), ...built]);
      return built[0]?.id ?? null;
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
    const api = getApi();
    if (!api) return;
    const foreign = getForeignShapes().find((s) => s.id === id);
    if (foreign) {
      setSelectedForeign(id);
      api.updateScene({
        appState: { selectedElementIds: {} },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
      return;
    }
    setSelectedForeign(null);
    const exists = allElements(api).some((e) => e.id === id && !e.isDeleted);
    api.updateScene({
      appState: { selectedElementIds: exists ? { [id]: true } : {} },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  }

  function getElements(): ExcalidrawElement[] {
    const api = getApi();
    if (!api) return [];
    return allElements(api).filter((e) => !e.isDeleted);
  }

  function getForeign(): ForeignShape[] {
    return getForeignShapes();
  }

  function getSelected(): Selected | null {
    const api = getApi();
    if (!api) return null;
    const selId = getSelectedForeignId();
    if (selId) {
      const shape = getForeignShapes().find((s) => s.id === selId);
      if (shape) return { kind: 'foreign', shape };
    }
    const ids = api.getAppState().selectedElementIds ?? {};
    const selected = allElements(api).filter((e) => !e.isDeleted && ids[e.id]);
    if (!selected.length) return null;
    return { kind: 'own', elements: selected };
  }

  function setProperty(id: string, key: string, value: PropertyValue): void {
    const api = getApi();
    if (!api) return;
    const current = allElements(api);
    const el = current.find((e) => e.id === id && !e.isDeleted);
    if (!el) return;
    const data = dataOf(el);
    if (!data || data.kind === 'image') return;

    if (data.kind === 'edge' && key === 'direction') {
      const direction = value as Direction;
      const heads = arrowheadsFor(direction);
      const updated = current.map((e) =>
        e.id === id
          ? newElementWith(e, { customData: { ...data, direction }, ...heads })
          : e,
      );
      replace(updated);
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
      const updated = current.map((e) => {
        if (e.id === id)
          return newElementWith(e, { customData: { ...data, [key]: value } });
        if (boundTextId && e.id === boundTextId) {
          // The bound text element (type: 'text') is the only variant with a
          // `text` field; `e` here is typed as the whole element union.
          // biome-ignore lint/suspicious/noExplicitAny: narrowing the whole ExcalidrawElement union by hand isn't worth it for one field
          return newElementWith(e, { text: displayText } as any);
        }
        return e;
      });
      replace(updated);
      return;
    }

    const properties = { ...data.properties, [key]: value };
    const updated = current.map((e) =>
      e.id === id
        ? newElementWith(e, { customData: { ...data, properties } })
        : e,
    );
    replace(updated);
  }

  function removeProperty(id: string, key: string): void {
    const api = getApi();
    if (!api) return;
    const current = allElements(api);
    const el = current.find((e) => e.id === id && !e.isDeleted);
    if (!el) return;
    const data = dataOf(el);
    if (!data || data.kind === 'image') return;
    const properties = { ...data.properties };
    delete properties[key];
    const updated = current.map((e) =>
      e.id === id
        ? newElementWith(e, { customData: { ...data, properties } })
        : e,
    );
    replace(updated);
  }

  function syncStatus(): SyncStatus {
    return getSyncStatus();
  }

  function deleteSelected(): void {
    const api = getApi();
    if (!api) return;
    const ids = api.getAppState().selectedElementIds ?? {};
    const idSet = new Set(Object.keys(ids).filter((id) => ids[id]));
    if (!idSet.size) return;
    const current = allElements(api);
    const updated = current.map((e) =>
      !e.isDeleted && idSet.has(e.id)
        ? newElementWith(e, { isDeleted: true })
        : e,
    );
    replace(updated);
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
    const api = getApi();
    if (!api) return null;
    const hit = hitAt({ x: x0, y: y0 }, allElements(api));
    if (!hit || hit.kind !== 'image') return null;
    const imgEl = liveImageElements(api).get(hit.imageId);
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
    const api = getApi();
    if (!api) return null;
    const elements = allElements(api);
    const fromHit = hitAt({ x: x0, y: y0 }, elements);
    const toHit = hitAt({ x: x1, y: y1 }, elements);
    if (!fromHit || !toHit || fromHit.id === toHit.id) return null;
    return connect(fromHit.id, toHit.id);
  }

  // -- dangling ---------------------------------------------------------------

  function getDangling(): DanglingEdge[] {
    const api = getApi();
    if (!api) return [];
    return allElements(api)
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
    const api = getApi();
    if (!api) return 0;
    const current = allElements(api);
    let count = 0;
    const updated = current.map((e) => {
      if (e.isDeleted || !isDangling(e)) return e;
      count++;
      return newElementWith(e, { isDeleted: true });
    });
    if (count) replace(updated);
    return count;
  }

  // -- rename -----------------------------------------------------------------

  async function rename(name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) return;
    await httpApi.updateSheet(getSheetId(), { name: trimmed });
    onRenamed(trimmed);
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
  };
}

declare global {
  interface Window {
    __digsite: Tools;
  }
}
