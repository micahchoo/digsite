// Where each picture sits in a comparison, and how one zoom moves both.
//
// Two pictures of different sizes cannot share a zoom in pixels. They share
// it in FOCUS units: each side is fitted on its own focus (a region's
// rectangle, or the whole picture), and the view is a zoom on that fit plus
// an offset measured in widths and heights of the focus. So the top-left
// corner of one region lines up with the top-left corner of the other, at
// every zoom. Pure: no DOM; Compare.tsx only applies the transforms.

/** A rectangle as fractions of its picture: the focus. */
export interface Focus {
  fx: number;
  fy: number;
  fw: number;
  fh: number;
}

export const WHOLE: Focus = { fx: 0, fy: 0, fw: 1, fh: 1 };

/** The shared view: zoom on the fitted focus, and where its centre has
 * moved, in focus widths (x) and heights (y). */
export interface View {
  zoom: number;
  px: number;
  py: number;
}

export const START: View = { zoom: 1, px: 0, py: 0 };
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 32;

export interface Side {
  /** The picture's own pixels. */
  width: number;
  height: number;
  focus: Focus;
}

export interface Pane {
  width: number;
  height: number;
}

/** Screen pixels per focus width and per focus height at zoom 1: the fit. */
function unit(side: Side, pane: Pane): { ux: number; uy: number; s0: number } {
  const fwPx = side.focus.fw * side.width;
  const fhPx = side.focus.fh * side.height;
  const s0 = Math.min(pane.width / (fwPx || 1), pane.height / (fhPx || 1));
  return { ux: fwPx * s0, uy: fhPx * s0, s0 };
}

/** Where to draw the whole picture in the pane for this view: its top-left
 * corner and its drawn size, in pane pixels. */
export function placement(
  side: Side,
  pane: Pane,
  view: View,
): { left: number; top: number; width: number; height: number } {
  const { s0 } = unit(side, pane);
  const s = s0 * view.zoom;
  const { fx, fy, fw, fh } = side.focus;
  const cx = (fx + fw * (0.5 + view.px)) * side.width;
  const cy = (fy + fh * (0.5 + view.py)) * side.height;
  return {
    left: pane.width / 2 - cx * s,
    top: pane.height / 2 - cy * s,
    width: side.width * s,
    height: side.height * s,
  };
}

const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

/** Zoom by `factor` keeping the focus point under `at` (pane pixels) where
 * it is, on the side the pointer is over. */
export function zoomAt(
  view: View,
  factor: number,
  at: { x: number; y: number },
  side: Side,
  pane: Pane,
): View {
  const zoom = clampZoom(view.zoom * factor);
  const { ux, uy } = unit(side, pane);
  const ax = view.px + (at.x - pane.width / 2) / (ux * view.zoom);
  const ay = view.py + (at.y - pane.height / 2) / (uy * view.zoom);
  return {
    zoom,
    px: ax - (at.x - pane.width / 2) / (ux * zoom),
    py: ay - (at.y - pane.height / 2) / (uy * zoom),
  };
}

/** Move the view by a screen drag of (dx, dy) on the given side. */
export function panBy(
  view: View,
  dx: number,
  dy: number,
  side: Side,
  pane: Pane,
): View {
  const { ux, uy } = unit(side, pane);
  return {
    ...view,
    px: view.px - dx / (ux * view.zoom),
    py: view.py - dy / (uy * view.zoom),
  };
}
