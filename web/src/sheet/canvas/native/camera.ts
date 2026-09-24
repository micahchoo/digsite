// Ported from research/image-graph/src/camera.ts — "where the canvas is
// looking, and every way it moves" — with the arithmetic rewritten for OUR
// convention rather than image-graph's. image-graph's camera is
// `{x, y, scale}` with `screen = world*scale + camera.{x,y}`; our `Viewport`
// (canvas/types.ts) is `{scrollX, scrollY, zoom}` with
// `screen = (world + scroll) * zoom` — fixed by the brief
// (docs/phases/2-sheet.md section 8) so `overlay/screen.ts`'s
// `sceneToScreen`/`screenToScene` share this convention. Every
// function here is pure and returns a new `Viewport`.
import type { Viewport, WheelInput } from '../types.ts';
import type { Point, Rect } from './geometry.ts';

// Product zoom limits; kept stable so saved viewport behavior stays familiar.
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 30;
const FIT_PADDING = 48;

const clamp = (value: number, low: number, high: number) =>
  Math.max(low, Math.min(high, value));

/** Screen point (canvas-relative, never client-relative — the caller
 * subtracts the canvas's own bounding rect) to world/scene point. */
export function toWorld(vp: Viewport, screenX: number, screenY: number): Point {
  return {
    x: screenX / vp.zoom - vp.scrollX,
    y: screenY / vp.zoom - vp.scrollY,
  };
}

export function toScreen(vp: Viewport, p: Point): Point {
  return { x: (p.x + vp.scrollX) * vp.zoom, y: (p.y + vp.scrollY) * vp.zoom };
}

/** What the viewport covers, in world coordinates. */
export function viewportRect(
  vp: Viewport,
  width: number,
  height: number,
): Rect {
  const topLeft = toWorld(vp, 0, 0);
  return {
    x: topLeft.x,
    y: topLeft.y,
    width: width / vp.zoom,
    height: height / vp.zoom,
  };
}

/**
 * Zoom about a screen point, leaving whatever is under it exactly where it
 * is — image-graph's `zoomAt` contract, carried over verbatim: the scale
 * clamps first and the shift is computed from the scale actually taken, so
 * a zoom that hits a limit stops rather than drifting.
 */
export function zoomAt(
  vp: Viewport,
  factor: number,
  at: Point,
  min = MIN_ZOOM,
  max = MAX_ZOOM,
): Viewport {
  const before = toWorld(vp, at.x, at.y);
  const zoom = clamp(vp.zoom * factor, min, max);
  if (zoom === vp.zoom) return vp;
  return {
    zoom,
    scrollX: at.x / zoom - before.x,
    scrollY: at.y / zoom - before.y,
  };
}

/** Pan by a screen-pixel delta; the content follows the pointer (dragging
 * right moves the view so content already under the pointer stays there). */
export function scrollBy(vp: Viewport, dx: number, dy: number): Viewport {
  return {
    ...vp,
    scrollX: vp.scrollX + dx / vp.zoom,
    scrollY: vp.scrollY + dy / vp.zoom,
  };
}

/** The viewport that shows all of `box`, `FIT_PADDING` screen px of margin
 * on every side.
 * (both are `sceneCoordsToViewportCoords` run backwards) so `zoomToFit`
 * feels identical between adapters. An empty `rects` union (null box, or a
 * non-positive container) returns the viewport unchanged. */
export function fitBox(
  box: Rect,
  containerWidth: number,
  containerHeight: number,
  current: Viewport,
  padding = FIT_PADDING,
): Viewport {
  if (containerWidth <= 0 || containerHeight <= 0) return current;
  const availW = Math.max(1, containerWidth - padding * 2);
  const availH = Math.max(1, containerHeight - padding * 2);
  const boxW = Math.max(1, box.width);
  const boxH = Math.max(1, box.height);
  const zoom = clamp(
    Math.min(availW / boxW, availH / boxH),
    MIN_ZOOM,
    MAX_ZOOM,
  );
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  return {
    zoom,
    scrollX: containerWidth / 2 / zoom - cx,
    scrollY: containerHeight / 2 / zoom - cy,
  };
}

/** Zoom by `factor` (>1 in, <1 out) about the container's own centre — the
 * toolbar's zoom in/out buttons, same contract as
 */
export function zoomBy(
  current: Viewport,
  factor: number,
  anchorX: number,
  anchorY: number,
): Viewport {
  return zoomAt(current, factor, { x: anchorX, y: anchorY });
}

/** What a wheel gesture asks for. A mouse wheel zooms about the pointer,
 * as the board map does (deck.gl's own wheel), so the two surfaces answer
 * one hand the same way; before 2026-09-24 it scrolled, image-graph's rule,
 * and a mouse could not zoom a sheet at all. A pinch (ctrl or the command
 * key, which browsers set on a trackpad pinch) zooms too. A trackpad's
 * two-finger slide pans: it is the one wheel that carries a sideways delta.
 * Shift makes any wheel pan, a one-axis wheel sideways. `deltaMode` is
 * normalised because Firefox reports lines and a page-mode wheel screens. */
export type WheelGesture =
  | { kind: 'zoom'; factor: number; into: boolean }
  | { kind: 'scroll'; dx: number; dy: number };

export function wheelGesture(
  event: WheelInput,
  viewportHeight: number,
  /** What a plain wheel does (Settings › The wheel on a sheet). `scroll`
   * is image-graph's rule: the wheel scrolls, Ctrl+wheel zooms. */
  plain: 'zoom' | 'scroll' = 'zoom',
): WheelGesture {
  const unit =
    event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewportHeight : 1;
  let dx = event.deltaX * unit;
  let dy = event.deltaY * unit;
  const zoom = (): WheelGesture => ({
    kind: 'zoom',
    factor: Math.exp(-dy * 0.0015),
    into: dy < 0,
  });
  if (event.ctrlKey || event.metaKey) return zoom();
  if (event.shiftKey) {
    if (!dx) {
      dx = dy;
      dy = 0;
    }
    return { kind: 'scroll', dx, dy };
  }
  if (dx || plain === 'scroll') return { kind: 'scroll', dx, dy };
  return zoom();
}
