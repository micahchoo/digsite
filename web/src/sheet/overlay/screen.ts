// Pure geometry helpers. Two jobs (docs/design.md "web/" §
// "The sheet page"):
//
// 1. scene -> screen, verified against
//      screenX = (sceneX + scrollX) * zoom + offsetLeft
//      screenY = (sceneY + scrollY) * zoom.value + offsetTop
//    `offset` is the overlay <svg>'s own box relative to the canvas container.
//    Sheet.tsx renders the svg as a full-bleed sibling over the canvas, so
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

export interface ConnectionLabelJob {
  id: string;
  label: string;
  line: readonly [Point, Point];
  priority: number;
  ignoreObstacleIds?: readonly string[];
}

export interface LabelObstacle extends Rect {
  id?: string;
}

export interface RegionLabelJob {
  id: string;
  label: string;
  rect: Rect;
  priority: number;
}

export interface PlacedRegionLabel extends PlacedConnectionLabel {
  leader: Point | null;
}

export interface PlacedConnectionLabel {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  textWidth: number;
}

function overlaps(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

/** Place connection labels around their lines while avoiding images and one
 * another. This is a display-only layout; it never writes back to the scene. */
export function placeConnectionLabels(
  jobs: readonly ConnectionLabelJob[],
  obstacles: readonly LabelObstacle[],
  width: number,
  height: number,
  measure: (label: string) => number,
): PlacedConnectionLabel[] {
  const along = [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8];
  const sides = [0, -1, 1, -2, 2];
  const labelHeight = 18;
  const padding = 7;
  const taken: Rect[] = [];
  const placed: PlacedConnectionLabel[] = [];

  for (const job of [...jobs].sort(
    (a, b) => b.priority - a.priority || a.id.localeCompare(b.id),
  )) {
    const textWidth = measure(job.label);
    const rawWidth = Math.ceil(textWidth) + padding * 2;
    const boxWidth = Math.min(Math.max(24, rawWidth), Math.max(24, width - 8));
    const [a, b] = job.line;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy) || 1;
    const nx = -dy / length;
    const ny = dx / length;
    let found: Rect | null = null;

    for (const fraction of along) {
      for (const side of sides) {
        const cx = a.x + dx * fraction + nx * side * labelHeight * 1.2;
        const cy = a.y + dy * fraction + ny * side * labelHeight * 1.2;
        const candidate = {
          x: cx - boxWidth / 2,
          y: cy - labelHeight / 2,
          width: boxWidth,
          height: labelHeight,
        };
        if (
          candidate.x < 4 ||
          candidate.y < 4 ||
          candidate.x + candidate.width > width - 4 ||
          candidate.y + candidate.height > height - 4 ||
          obstacles.some(
            (obstacle) =>
              !job.ignoreObstacleIds?.includes(obstacle.id ?? '') &&
              overlaps(candidate, obstacle),
          ) ||
          taken.some((other) => overlaps(candidate, other))
        ) {
          continue;
        }
        found = candidate;
        break;
      }
      if (found) break;
    }

    if (found) {
      taken.push(found);
      placed.push({ ...found, id: job.id, label: job.label, textWidth });
    }
  }
  return placed;
}

/** Keep foreign-region labels readable when claims occupy the same area.
 * Their candidates sit inside or beside their owning rectangle; every placed
 * label and caller-supplied obstacle is display-only. */
export function placeRegionLabels(
  jobs: readonly RegionLabelJob[],
  obstacles: readonly Rect[],
  width: number,
  height: number,
  measure: (label: string) => number,
): PlacedRegionLabel[] {
  const labelHeight = 18;
  const padding = 7;
  const gap = 4;
  const taken = [...obstacles];
  const placed: PlacedRegionLabel[] = [];

  for (const job of [...jobs].sort(
    (a, b) => b.priority - a.priority || a.id.localeCompare(b.id),
  )) {
    const textWidth = measure(job.label);
    const boxWidth = Math.min(
      Math.max(24, Math.ceil(textWidth) + padding * 2),
      Math.max(24, width - 8),
    );
    const r = job.rect;
    const left = r.x + gap;
    const right = r.x + r.width - boxWidth - gap;
    const top = r.y + gap;
    const bottom = r.y + r.height - labelHeight - gap;
    const midY = r.y + (r.height - labelHeight) / 2;
    const candidates = [
      { x: left, y: top },
      { x: right, y: top },
      { x: left, y: bottom },
      { x: right, y: bottom },
      { x: r.x - boxWidth - gap, y: top },
      { x: r.x + r.width + gap, y: top },
      { x: left, y: r.y - labelHeight - gap },
      { x: right, y: r.y - labelHeight - gap },
      { x: left, y: r.y + r.height + gap },
      { x: right, y: r.y + r.height + gap },
      { x: r.x - boxWidth - gap, y: midY },
      { x: r.x + r.width + gap, y: midY },
    ];
    const candidate = candidates.find((position) => {
      const box = { ...position, width: boxWidth, height: labelHeight };
      return (
        box.x >= 4 &&
        box.y >= 4 &&
        box.x + box.width <= width - 4 &&
        box.y + box.height <= height - 4 &&
        !taken.some((other) => overlaps(box, other))
      );
    });
    if (!candidate) continue;

    const box = { ...candidate, width: boxWidth, height: labelHeight };
    taken.push(box);
    const center = {
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
    };
    const nearest = {
      x: Math.max(r.x, Math.min(r.x + r.width, center.x)),
      y: Math.max(r.y, Math.min(r.y + r.height, center.y)),
    };
    const leader =
      Math.hypot(nearest.x - center.x, nearest.y - center.y) > 12
        ? nearest
        : null;
    placed.push({ ...box, id: job.id, label: job.label, textWidth, leader });
  }
  return placed;
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

/** The minimal shape screen.ts needs from a live canvas element. */
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
 * earlier render), the rect of the copy. Kept here, free of canvas renderer
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
