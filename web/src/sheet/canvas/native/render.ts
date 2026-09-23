// One frame, from the scene plus a frame state, canvas 2D — ported in
// spirit from research/image-graph/src/canvas-renderer.ts/render.ts: own
// elements only (never foreign — `overlay/Overlay.tsx` draws those, on its
// own `<svg>` above whichever canvas is mounted, unchanged by which
// adapter this is: ../../../../.claude/rules/foreign-never-in-scene.md).
// Every rect and every edge segment drawn here is the SAME one `scene.ts`'s
// `hitAt` measures — ../../../../.claude/rules/image-graph-hit-what-was-drawn.md.
import { dataOf, fileId as fileIdFor } from '@digsite/shared';
import type { Palette } from '../../../theme/palette.ts';
import { withAlpha } from '../../../theme/palette.ts';
import {
  connectionOpacity,
  endImages,
  focusOf,
  inFocus,
} from '../../connection-emphasis.ts';
import { regionChip, regionLabelOf, truncateLabel } from '../../labels.ts';
import { edgePaths } from '../../routing.ts';
import type { Arrowhead, SceneElement, Viewport } from '../types.ts';
import { toScreen } from './camera.ts';
import type { Point, Rect } from './geometry.ts';
import type { ImageCache } from './images.ts';
import { gripsShown, paintOrder, regionHandles } from './scene.ts';

// Every colour comes from `palette`, read from theme/tokens.css.
const UI_FONT = 'system-ui, sans-serif';
const ARROW_HEAD_LEN = 10;
const ARROW_HEAD_ANGLE = Math.PI / 7;
const GRIP_SIZE = 6;
/** Corner radius of a routed line, in screen pixels. */
const CORNER = 10;

/** How sure the claim is, as a line style: confirmed and unstated are
 * solid, likely is dashed, unverified is dotted. Read without a legend
 * because the gaps grow as the certainty falls. */
const CONFIDENCE_DASH: Record<string, number[]> = {
  likely: [9, 5],
  unverified: [2, 4],
};

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
  /** imageId -> name, drawn under a picture wide enough to hold it. */
  captions?: ReadonlyMap<string, string>;
  palette: Palette;
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

function drawImageOrPlaceholder(
  ctx: CanvasRenderingContext2D,
  imageId: string,
  screen: Rect,
  images: ImageCache,
  palette: Palette,
): void {
  const bitmap = images.get(fileIdFor(imageId));
  if (bitmap) {
    ctx.drawImage(bitmap, screen.x, screen.y, screen.width, screen.height);
    return;
  }
  ctx.fillStyle = palette.placeholder;
  ctx.fillRect(screen.x, screen.y, screen.width, screen.height);
  ctx.strokeStyle = palette.line;
  ctx.lineWidth = 1;
  ctx.strokeRect(
    screen.x + 0.5,
    screen.y + 0.5,
    screen.width - 1,
    screen.height - 1,
  );
}

/** Alpha of a region on a picture the selection does not touch. */
const OFF_FOCUS_REGION = 0.35;

/** A region's outline, and its label on a chip just above its top-left
 * corner: on the picture itself text has no background it can be read
 * against. `overlay/Overlay.tsx` keeps other labels off this chip. */
function drawRegion(
  ctx: CanvasRenderingContext2D,
  screen: Rect,
  label: string,
  selected: boolean,
  focused: boolean,
  palette: Palette,
): void {
  const stroke = selected ? palette.accent : palette.claimOwn;
  ctx.globalAlpha = focused ? 1 : OFF_FOCUS_REGION;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = selected ? 2.5 : 1.5;
  ctx.strokeRect(screen.x, screen.y, screen.width, screen.height);
  if (label) {
    ctx.font = `11px ${UI_FONT}`;
    const text = truncateLabel(label);
    const chip = regionChip(screen, ctx.measureText(text).width);
    ctx.fillStyle = withAlpha(palette.canvas, 0.92);
    ctx.fillRect(chip.x, chip.y, chip.width, chip.height);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.strokeRect(chip.x + 0.5, chip.y + 0.5, chip.width - 1, chip.height - 1);
    ctx.fillStyle = stroke;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, chip.x + 4, chip.y + chip.height / 2);
  }
  ctx.globalAlpha = 1;
}

/** A filled or hollow triangle at `tip`, pointing away from `from` — the
 * dangling-end marker (`triangle_outline`, from `../../dangling.ts`'s own
 * rebind) and a plain direction arrowhead (`arrow`) drawn the same way. */
function drawArrowhead(
  ctx: CanvasRenderingContext2D,
  tip: Point,
  from: Point,
  kind: Arrowhead,
  color: string,
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
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  } else {
    ctx.fillStyle = color;
    ctx.fill();
  }
}

/** A polyline with its corners rounded, so a routed line reads as one
 * line and not as several meeting at a point. */
function strokePath(ctx: CanvasRenderingContext2D, points: Point[]): void {
  const first = points[0];
  if (!first) return;
  ctx.beginPath();
  ctx.moveTo(first.x, first.y);
  for (let i = 1; i < points.length - 1; i++) {
    const at = points[i] as Point;
    const next = points[i + 1] as Point;
    const before = points[i - 1] as Point;
    const radius = Math.min(
      CORNER,
      Math.hypot(at.x - before.x, at.y - before.y) / 2,
      Math.hypot(next.x - at.x, next.y - at.y) / 2,
    );
    ctx.arcTo(at.x, at.y, next.x, next.y, radius);
  }
  const last = points[points.length - 1] as Point;
  ctx.lineTo(last.x, last.y);
  ctx.stroke();
}

function drawEdge(
  ctx: CanvasRenderingContext2D,
  el: SceneElement,
  path: readonly Point[],
  vp: Viewport,
  selected: boolean,
  opacity: number,
  confidence: string | undefined,
  palette: Palette,
): void {
  const points = path.map((p) => toScreen(vp, p));
  const start = points[0];
  const end = points[points.length - 1];
  if (!start || !end) return;
  const color = selected ? palette.accent : palette.claimEdge;
  ctx.strokeStyle = color;
  ctx.globalAlpha = opacity;
  ctx.lineWidth = selected ? 2.5 : 1.5;
  ctx.setLineDash((confidence && CONFIDENCE_DASH[confidence]) || []);
  strokePath(ctx, points);
  ctx.setLineDash([]);
  // Each head points along the segment it ends, not along the chord.
  drawArrowhead(ctx, start, points[1] ?? end, el.startArrowhead, color);
  drawArrowhead(ctx, end, points.at(-2) ?? start, el.endArrowhead, color);
  ctx.globalAlpha = 1;
}

function drawGrips(
  ctx: CanvasRenderingContext2D,
  rect: Rect,
  vp: Viewport,
  palette: Palette,
): void {
  ctx.fillStyle = palette.canvas;
  ctx.strokeStyle = palette.accent;
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
    captions,
    palette,
  } = input;
  ctx.save();
  ctx.fillStyle = palette.canvas;
  ctx.fillRect(0, 0, width, height);

  const byId = new Map(elements.map((e) => [e.id, e] as const));
  const paths = edgePaths(elements, viewport.zoom);
  const focus = focusOf(elements, selectedIds);

  for (const el of paintOrder(elements)) {
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
        palette,
      );
      if (selected) {
        // Outside the picture, clear of it, so no pixel of it is covered.
        const r = screenRect(rectOf(el), viewport);
        ctx.strokeStyle = palette.accent;
        ctx.lineWidth = 2;
        ctx.strokeRect(r.x - 4, r.y - 4, r.width + 8, r.height + 8);
      }
      continue;
    }
    if (data.kind === 'region') {
      drawRegion(
        ctx,
        screenRect(rectOf(el), viewport),
        regionLabelOf(el, byId),
        selected,
        !focus || selected || focus.images.has(data.imageId),
        palette,
      );
      continue;
    }
    if (data.kind === 'edge') {
      const path = paths.get(el.id);
      if (!path) continue;
      drawEdge(
        ctx,
        el,
        path,
        viewport,
        selected,
        connectionOpacity(
          data.relation,
          dimRelations ?? null,
          inFocus(focus, el.id, endImages(el, byId)),
        ),
        data.confidence,
        palette,
      );
    }
  }

  // Grips only for a single selected region — matches
  // docs/phases/2-sheet.md section 8's "grips on a selected region".
  if (selectedIds.size === 1) {
    const [onlyId] = selectedIds;
    const el = onlyId ? byId.get(onlyId) : undefined;
    if (
      el &&
      !el.isDeleted &&
      dataOf(el)?.kind === 'region' &&
      gripsShown(el, viewport.zoom)
    ) {
      drawGrips(ctx, rectOf(el), viewport, palette);
    }
  }

  if (captions) drawCaptions(ctx, elements, viewport, captions, palette);
  drawGroupBand(ctx, elements, selectedIds, viewport, palette);

  if (marquee) {
    const r = screenRect(marquee, viewport);
    ctx.fillStyle = withAlpha(palette.accent, 0.1);
    ctx.fillRect(r.x, r.y, r.width, r.height);
    ctx.strokeStyle = palette.accent;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(r.x, r.y, r.width, r.height);
    ctx.setLineDash([]);
  }

  ctx.restore();
}

/** Below this on-screen width a caption is noise over the picture below. */
const CAPTION_MIN_WIDTH = 60;
const CAPTION_HEIGHT = 14;
const CAPTION_GAP = 8;

/** Each picture's name under it, when the picture is wide enough and the
 * caption's box touches no other picture. image-graph's captions: a name
 * that would sit on the next picture is not drawn at all. */
function drawCaptions(
  ctx: CanvasRenderingContext2D,
  elements: readonly SceneElement[],
  vp: Viewport,
  captions: ReadonlyMap<string, string>,
  palette: Palette,
): void {
  const pictures: { rect: Rect; imageId: string }[] = [];
  for (const el of elements) {
    if (el.isDeleted) continue;
    const data = dataOf(el);
    if (data?.kind === 'image')
      pictures.push({
        rect: screenRect(rectOf(el), vp),
        imageId: data.imageId,
      });
  }
  ctx.font = `11px ${UI_FONT}`;
  ctx.fillStyle = palette.textSecondary;
  ctx.textBaseline = 'top';
  for (const { rect, imageId } of pictures) {
    if (rect.width < CAPTION_MIN_WIDTH) continue;
    const name = captions.get(imageId);
    if (!name) continue;
    const box = {
      x: rect.x,
      // Below the selection ring, which sits 4 px outside the picture.
      y: rect.y + rect.height + CAPTION_GAP,
      width: rect.width,
      height: CAPTION_HEIGHT,
    };
    const blocked = pictures.some(
      (other) =>
        other.rect !== rect &&
        box.x < other.rect.x + other.rect.width &&
        other.rect.x < box.x + box.width &&
        box.y < other.rect.y + other.rect.height &&
        other.rect.y < box.y + box.height,
    );
    if (blocked) continue;
    ctx.fillText(fitText(ctx, name, box.width), box.x, box.y);
  }
}

/** `text` cut with an ellipsis to fit `width` pixels in the current font. */
function fitText(
  ctx: CanvasRenderingContext2D,
  text: string,
  width: number,
): string {
  if (ctx.measureText(text).width <= width) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= width) lo = mid;
    else hi = mid - 1;
  }
  return lo ? `${text.slice(0, lo)}…` : '';
}

/** Several selected: one dashed band around all of them, so the group
 * reads as one thing the next action will act on. */
function drawGroupBand(
  ctx: CanvasRenderingContext2D,
  elements: readonly SceneElement[],
  selectedIds: ReadonlySet<string>,
  vp: Viewport,
  palette: Palette,
): void {
  if (selectedIds.size < 2) return;
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const el of elements) {
    if (el.isDeleted || !selectedIds.has(el.id)) continue;
    const kind = dataOf(el)?.kind;
    if (kind !== 'image' && kind !== 'region') continue;
    left = Math.min(left, el.x);
    top = Math.min(top, el.y);
    right = Math.max(right, el.x + el.width);
    bottom = Math.max(bottom, el.y + el.height);
  }
  if (!Number.isFinite(left)) return;
  const r = screenRect(
    { x: left, y: top, width: right - left, height: bottom - top },
    vp,
  );
  ctx.strokeStyle = palette.accent;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  // Deeper below, so the band holds the captions rather than crossing them.
  const below = CAPTION_GAP + CAPTION_HEIGHT + 4;
  ctx.strokeRect(r.x - 12, r.y - 12, r.width + 24, r.height + 12 + below);
  ctx.setLineDash([]);
}
