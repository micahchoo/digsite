// What a scene point lands on: an image, a region, or nothing. Pure — takes
// the live element list (already the shape screen.ts's ElementLike wants),
// no DOM, no Excalidraw import. The region and edge tools both start with
// this (docs/phases/2-sheet.md section 1): a region drag must start on an
// image, an edge pick must land on an image or an own region.
//
// Regions draw on top of their image, so a later element in the array wins
// a point both could claim — Excalidraw's own z-order is array order, and
// this mirrors it without reading anything Excalidraw-specific.

import { dataOf } from '@digsite/shared';
import type { ElementLike, Point } from './overlay/screen.ts';

export interface Hit {
  id: string;
  kind: 'image' | 'region';
  imageId: string;
}

function containsPoint(el: ElementLike, p: Point): boolean {
  return (
    p.x >= el.x &&
    p.x <= el.x + el.width &&
    p.y >= el.y &&
    p.y <= el.y + el.height
  );
}

/** The topmost image or region at `p`, or null over empty canvas. Deleted
 * elements are never candidates. */
export function hitAt(p: Point, elements: readonly ElementLike[]): Hit | null {
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i];
    if (!el || el.isDeleted) continue;
    if (!containsPoint(el, p)) continue;
    const data = dataOf(el);
    if (data?.kind === 'region')
      return { id: el.id, kind: 'region', imageId: data.imageId };
    if (data?.kind === 'image')
      return { id: el.id, kind: 'image', imageId: data.imageId };
  }
  return null;
}
