// One frame, from the scene plus a frame state, canvas 2D — ported in
// spirit from research/image-graph/src/canvas-renderer.ts/render.ts: own
// elements only (never foreign — `overlay/Overlay.tsx` draws those, on its
// own `<svg>` above whichever canvas is mounted, unchanged by which
// adapter this is: ../../../../.claude/rules/foreign-never-in-scene.md).
// Every rect and every edge segment drawn here is the SAME one `scene.ts`'s
// `hitAt` measures — ../../../../.claude/rules/image-graph-hit-what-was-drawn.md.
import { dataOf, fileId as fileIdFor } from '@digsite/shared';
import { relationOpacity } from '../../connection-emphasis.ts';
import type { Arrowhead, SceneElement, Viewport } from '../types.ts';
import { toScreen } from './camera.ts';
import type { Point, Rect } from './geometry.ts';
import type { ImageCache } from './images.ts';
import { type HandleId, regionHandles } from './scene.ts';

// Colors match the sheet's semantic canvas tokens.
const REGION_STROKE = '#1971c2';
const EDGE_STROKE = '#2f9e44';
const SELECTION_STROKE = '#1971c2';
const PLACEHOLDER_FILL = '#e9ecef';
const PLACEHOLDER_STROKE = '#adb5bd';
const UI_FONT = 'system-ui, sans-serif';
const ARROW_HEAD_LEN = 10;
const ARROW_HEAD_ANGLE = Math.PI / 7;
const GRIP_SIZE = 6;

export interface RenderInput {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  viewport: Viewport;
  elements: readonly SceneElement[];
  selectedIds: ReadonlySet<string>;
  images: ImageCache;
  /** A region drag-to-draw or band-select in progress, scene space. */
  marquee?: Rect | null;
  /** Display-only relation emphasis. */
  dimRelations?: string | null;
}

function rectOf(el: SceneElement): Rect {
  return { x: el.x, y: el.y, width: el.width, height: el.height };
}

function screenRect(r: Rect, vp: Viewport): Rect {
  const topLeft = toScreen(vp, { x: r.x, y: r.y });
  return {
    x: topLeft.x,
    y: topLeft.y,
    width: r.width * vp.zoom,
    height: r.height * vp.zoom,
  };
}

function boundText(
  el: SceneElement,
  byId: Map<string, SceneElement>,
): string | null {
  const textId = el.boundElements?.find((b) => b.type === 'text')?.id;
  if (!textId) return null;
  return byId.get(textId)?.text ?? null;
}

function drawImageOrPlaceholder(
  ctx: CanvasRenderingContext2D,
  imageId: string,
  screen: Rect,
  images: ImageCache,
): void {
  const bitmap = images.get(fileIdFor(imageId));
  if (bitmap) {
    ctx.drawImage(bitmap, screen.x, screen.y, screen.width, screen.height);
    return;
  }
  ctx.fillStyle = PLACEHOLDER_FILL;
  ctx.fillRect(screen.x, screen.y, screen.width, screen.height);
  ctx.strokeStyle = PLACEHOLDER_STROKE;
  ctx.lineWidth = 2;
  ctx.strokeRect(
    screen.x + 1,
    screen.y + 1,
    screen.width - 2,
    screen.height - 2,
  );
}

function drawRegion(
  ctx: CanvasRenderingContext2D,
  screen: Rect,
  label: string | null,
  selected: boolean,
): void {
  ctx.strokeStyle = REGION_STROKE;
  ctx.lineWidth = selected ? 2.5 : 1.5;
  ctx.strokeRect(screen.x, screen.y, screen.width, screen.height);
  if (label) {
    ctx.font = `11px ${UI_FONT}`;
    ctx.fillStyle = REGION_STROKE;
    ctx.textBaseline = 'top';
    ctx.fillText(
      label,
      screen.x + 4,
      screen.y + 3,
      Math.max(0, screen.width - 8),
    );
  }
}

/** A filled or hollow triangle at `tip`, pointing away from `from` — the
 * dangling-end marker (`triangle_outline`, from `../../dangling.ts`'s own
 * rebind) and a plain direction arrowhead (`arrow`) drawn the same way. */
function drawArrowhead(
  ctx: CanvasRenderingContext2D,
  tip: Point,
  from: Point,
  kind: Arrowhead,
): void {
  if (!kind) return;
  const angle = Math.atan2(tip.y - from.y, tip.x - from.x);
  const a = {
    x: tip.x - ARROW_HEAD_LEN * Math.cos(angle - ARROW_HEAD_ANGLE),
    y: tip.y - ARROW_HEAD_LEN * Math.sin(angle - ARROW_HEAD_ANGLE),
  };
  const b = {
    x: tip.x - ARROW_HEAD_LEN * Math.cos(angle + ARROW_HEAD_ANGLE),
    y: tip.y - ARROW_HEAD_LEN * Math.sin(angle + ARROW_HEAD_ANGLE),
  };
  ctx.beginPath();
  ctx.moveTo(tip.x, tip.y);
  ctx.lineTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.closePath();
  if (kind === 'triangle_outline') {
    ctx.strokeStyle = EDGE_STROKE;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  } else {
    ctx.fillStyle = EDGE_STROKE;
    ctx.fill();
  }
}

function drawEdge(
  ctx: CanvasRenderingContext2D,
  el: SceneElement,
  vp: Viewport,
  selected: boolean,
  relationOpacityValue: number,
): void {
  const first = el.points[0] ?? [0, 0];
  const last = el.points[el.points.length - 1] ?? first;
  const start = toScreen(vp, { x: el.x + first[0], y: el.y + first[1] });
  const end = toScreen(vp, { x: el.x + last[0], y: el.y + last[1] });
  ctx.strokeStyle = EDGE_STROKE;
  ctx.globalAlpha = relationOpacityValue;
  ctx.lineWidth = selected ? 2.5 : 1.5;
  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  ctx.lineTo(end.x, end.y);
  ctx.stroke();
  drawArrowhead(ctx, start, end, el.startArrowhead);
  drawArrowhead(ctx, end, start, el.endArrowhead);
  ctx.globalAlpha = 1;
}

function drawGrips(
  ctx: CanvasRenderingContext2D,
  rect: Rect,
  vp: Viewport,
): void {
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = SELECTION_STROKE;
  ctx.lineWidth = 1.5;
  for (const g of regionHandles(rect)) {
    const p = toScreen(vp, g);
    ctx.beginPath();
    ctx.rect(p.x - GRIP_SIZE / 2, p.y - GRIP_SIZE / 2, GRIP_SIZE, GRIP_SIZE);
    ctx.fill();
    ctx.stroke();
  }
}

export function renderFrame(input: RenderInput): void {
  const {
    ctx,
    width,
    height,
    viewport,
    elements,
    selectedIds,
    images,
    marquee,
    dimRelations,
  } = input;
  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  const byId = new Map(elements.map((e) => [e.id, e] as const));

  for (const el of elements) {
    if (el.isDeleted) continue;
    const data = dataOf(el);
    if (!data) continue; // a bound text or anything else drawn via its container
    const selected = selectedIds.has(el.id);

    if (data.kind === 'image') {
      drawImageOrPlaceholder(
        ctx,
        data.imageId,
        screenRect(rectOf(el), viewport),
        images,
      );
      if (selected) {
        const r = screenRect(rectOf(el), viewport);
        ctx.strokeStyle = SELECTION_STROKE;
        ctx.lineWidth = 2;
        ctx.strokeRect(r.x, r.y, r.width, r.height);
      }
      continue;
    }
    if (data.kind === 'region') {
      drawRegion(
        ctx,
        screenRect(rectOf(el), viewport),
        boundText(el, byId),
        selected,
      );
      continue;
    }
    if (data.kind === 'edge') {
      drawEdge(
        ctx,
        el,
        viewport,
        selected,
        relationOpacity(data.relation, dimRelations ?? null),
      );
    }
  }

  // Grips only for a single selected region — matches
  // docs/phases/2-sheet.md section 8's "grips on a selected region".
  if (selectedIds.size === 1) {
    const [onlyId] = selectedIds;
    const el = onlyId ? byId.get(onlyId) : undefined;
    if (el && !el.isDeleted && dataOf(el)?.kind === 'region') {
      drawGrips(ctx, rectOf(el), viewport);
    }
  }

  if (marquee) {
    const r = screenRect(marquee, viewport);
    ctx.fillStyle = 'rgba(25, 113, 194, 0.08)';
    ctx.fillRect(r.x, r.y, r.width, r.height);
    ctx.strokeStyle = SELECTION_STROKE;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(r.x, r.y, r.width, r.height);
    ctx.setLineDash([]);
  }

  ctx.restore();
}
