// Pure: no DOM, no Excalidraw import. Two jobs (docs/design.md "web/" §
// "The sheet page"):
//
// 1. scene -> screen, verified against
//    research/excalidraw/packages/common/src/utils.ts#sceneCoordsToViewportCoords:
//      screenX = (sceneX + scrollX) * zoom.value + offsetLeft
//      screenY = (sceneY + scrollY) * zoom.value + offsetTop
//    `offset` is the overlay <svg>'s own box relative to the SAME container
//    Excalidraw measures offsetLeft/offsetTop from. Sheet.tsx renders the
//    svg as a full-bleed sibling inset over Excalidraw's own container, so
//    at the call site `offset` is always {left: 0, top: 0} — both boxes
//    share one origin, and offsetLeft/offsetTop cancel. The parameter stays
//    explicit so this stays testable without a DOM.
//
// 2. foreignShapes(rows, elements): today's foreign claims, in scene space,
//    from the CURRENT image (and region) element rects — never a cached
//    poll result. See ../../../.claude/rules/foreign-never-in-scene.md.

import {
  type EdgeEnd,
  type Foreign,
  type ForeignEdge,
  type ForeignRegion,
  type Fraction,
  dataOf,
  fromFraction,
} from '@digsite/shared';

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Viewport {
  scrollX: number;
  scrollY: number;
  zoom: number;
}

export interface ContainerOffset {
  left: number;
  top: number;
}

export function sceneToScreen(
  p: Point,
  vp: Viewport,
  offset: ContainerOffset,
): Point {
  return {
    x: (p.x + vp.scrollX) * vp.zoom + offset.left,
    y: (p.y + vp.scrollY) * vp.zoom + offset.top,
  };
}

/** The inverse of `sceneToScreen` — what DrawLayer.tsx converts a real
 * pointer event's client position into before calling
 * `tools.ts#pointerDraw`/`pointerConnect`, both of which take scene
 * coordinates only. */
export function screenToScene(
  p: Point,
  vp: Viewport,
  offset: ContainerOffset,
): Point {
  return {
    x: (p.x - offset.left) / vp.zoom - vp.scrollX,
    y: (p.y - offset.top) / vp.zoom - vp.scrollY,
  };
}

export function rectToScreen(
  r: Rect,
  vp: Viewport,
  offset: ContainerOffset,
): Rect {
  const topLeft = sceneToScreen({ x: r.x, y: r.y }, vp, offset);
  return {
    x: topLeft.x,
    y: topLeft.y,
    width: r.width * vp.zoom,
    height: r.height * vp.zoom,
  };
}

/** The minimal shape screen.ts needs from a live Excalidraw element. */
export interface ElementLike {
  id: string;
  isDeleted?: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  customData?: unknown;
}

export type ForeignShape =
  | {
      id: string;
      kind: 'region';
      rect: Rect;
      label: string;
      sheetName: string;
      row: ForeignRegion;
    }
  | {
      id: string;
      kind: 'edge';
      line: [Point, Point];
      label: string;
      sheetName: string;
      row: ForeignEdge;
      // Dangling from a vanished foreign region (docs/phases/2-sheet.md
      // section 5, the overlay side): true when that end's `regionSourceId`
      // is set but no region with that claim id came back in THIS SAME
      // poll — the owning sheet deleted it (or this poll simply landed
      // between its two queries; either way, nothing here to bind to).
      // Overlay.tsx draws a hollow marker at a true end. Never a scene
      // change — see ../../../.claude/rules/foreign-never-in-scene.md.
      danglingStart: boolean;
      danglingEnd: boolean;
    };

/**
 * The pure heart of `tools.ts#copyForeign`: given a foreign row's fraction
 * and the image's rect NOW (never a rect cached from an earlier poll or an
 * earlier render), the rect of the copy. Kept here, free of any Excalidraw
 * import, so it is testable without constructing a scene — see
 * ../../../test/copy-foreign.test.ts and
 * ../../../.claude/rules/foreign-never-in-scene.md ("Never read the
 * overlay's last-rendered rect").
 */
export function foreignCopyRect(row: Fraction, imageRectNow: Rect): Rect {
  return fromFraction(row, imageRectNow);
}

function rectOf(el: ElementLike): Rect {
  return { x: el.x, y: el.y, width: el.width, height: el.height };
}

function centerOf(r: Rect): Point {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/**
 * Every foreign shape's CURRENT scene-space geometry, from `rows` (a
 * `/sheets/:id/foreign` poll) and the scene's own image elements read fresh
 * every call. `copyForeign` (../tools.ts) does the same recomputation
 * independently at write time rather than reusing a shape from here — see
 * the rule this file is scoped by.
 */
export function foreignShapes(
  rows: Foreign,
  elements: readonly ElementLike[],
): ForeignShape[] {
  const images = new Map<string, Rect>();
  for (const el of elements) {
    if (el.isDeleted) continue;
    const data = dataOf(el);
    if (data?.kind === 'image') images.set(data.imageId, rectOf(el));
  }

  const regionCenterByClaim = new Map<string, Point>();
  const shapes: ForeignShape[] = [];

  for (const r of rows.regions) {
    const image = images.get(r.imageId);
    if (!image) continue;
    const rect = fromFraction(r, image);
    regionCenterByClaim.set(`${r.sheetId}:${r.sourceId}`, centerOf(rect));
    shapes.push({
      id: `region-${r.id}`,
      kind: 'region',
      rect,
      label: r.label,
      sheetName: r.sheetName,
      row: r,
    });
  }

  function endpoint(
    edgeSheetId: string,
    end: EdgeEnd,
  ): { point: Point; dangling: boolean } | null {
    const image = images.get(end.imageId);
    if (!image) return null; // the image itself is gone from THIS scene: omitted, not an error
    if (end.regionSourceId) {
      const claimed = regionCenterByClaim.get(
        `${edgeSheetId}:${end.regionSourceId}`,
      );
      if (claimed) return { point: claimed, dangling: false };
      // The region end vanished (or a poll race) — draw to the image's
      // rect instead, marked dangling for Overlay.tsx's hollow marker.
      return { point: centerOf(image), dangling: true };
    }
    return { point: centerOf(image), dangling: false };
  }

  for (const e of rows.edges) {
    const from = endpoint(e.sheetId, e.source);
    const to = endpoint(e.sheetId, e.target);
    if (!from || !to) continue; // an end's image is gone: tolerated by omission, not an error
    shapes.push({
      id: `edge-${e.id}`,
      kind: 'edge',
      line: [from.point, to.point],
      danglingStart: from.dangling,
      danglingEnd: to.dangling,
      label: e.relation,
      sheetName: e.sheetName,
      row: e,
    });
  }

  return shapes;
}
