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
  getElements: () => ExcalidrawElement[];
  getForeign: () => ForeignShape[];
  getSelected: () => Selected | null;
  setProperty: (id: string, key: string, value: PropertyValue) => void;
  removeProperty: (id: string, key: string) => void;
  syncStatus: () => SyncStatus;
}

export interface ToolsDeps {
  getApi: () => ExcalidrawImperativeAPI | null;
  getForeignShapes: () => ForeignShape[];
  getSelectedForeignId: () => string | null;
  setSelectedForeign: (id: string | null) => void;
  getSyncStatus: () => SyncStatus;
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
    const built = convertToExcalidrawElements([
      {
        type: 'rectangle',
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        groupIds: [imageGroupId(imageId)],
        customData: { kind: 'region', imageId, label, properties: {} },
        label: label ? { text: label } : undefined,
        // biome-ignore lint/suspicious/noExplicitAny: Excalidraw's skeleton union is not worth narrowing by hand
      } as any,
    ]) as ExcalidrawElement[];
    replace([...allElements(api), ...built]);
    return built[0]?.id ?? null;
  }

  function connect(
    fromId: string,
    toId: string,
    relation = '',
    direction: Direction = 'none',
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
      const updated = current.map((e) => {
        if (e.id === id)
          return newElementWith(e, { customData: { ...data, [key]: value } });
        if (boundTextId && e.id === boundTextId) {
          // The bound text element (type: 'text') is the only variant with a
          // `text` field; `e` here is typed as the whole element union.
          // biome-ignore lint/suspicious/noExplicitAny: narrowing the whole ExcalidrawElement union by hand isn't worth it for one field
          return newElementWith(e, { text: String(value) } as any);
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

  return {
    drawRegion,
    connect,
    moveImage,
    setRegionRect,
    copyForeign,
    select,
    getElements,
    getForeign,
    getSelected,
    setProperty,
    removeProperty,
    syncStatus,
  };
}

declare global {
  interface Window {
    __digsite: Tools;
  }
}
