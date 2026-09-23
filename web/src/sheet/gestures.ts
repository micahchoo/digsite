// What a pointer press means, decided in ONE pure function — image-graph's
// pattern (research/image-graph/src/gestures.ts: `pressIntent`/`dragBecomes`,
// "the decision of what a pointer means lives in one pure function"). No
// DOM or canvas imports: Toolbar.tsx and Sheet.tsx call `pointerIntent`
// with what is under the press and act on the answer; the deciding never
// lives at the call site.
//
// Four tools (docs/phases/2-sheet.md section 1): select and pan use the
// canvas interaction path. region and edge are ours: region only starts a draw
// when the press lands on an image; edge only starts a pick when the press
// lands on an image or an own region, and a second pick (there is already a
// pending source) completes the edge rather than starting a new one.

export type Tool = 'select' | 'region' | 'edge' | 'pan';

/** What the pointer's press landed on, decided by the caller (a hit test
 * against the live scene) — this module never touches a scene itself. */
export type Target = 'image' | 'region' | 'edge' | 'empty';

export type Intent =
  | 'pan' // Space or middle drag: move the camera through any tool
  | 'native' // let the canvas interaction path handle it
  | 'draw-region' // region tool, pressed on an image: drag draws a region
  | 'edge-source' // edge tool, no pending source yet: this press sets it
  | 'edge-target'; // edge tool, a source is already pending: this press completes the edge

export interface PointerInput {
  tool: Tool;
  target: Target;
  /** Space or the middle button takes precedence over authoring tools. */
  forcePan?: boolean;
  /** True once the edge tool has a source picked and is waiting for a target. */
  pendingSource: boolean;
}

export function pointerIntent({
  tool,
  target,
  pendingSource,
  forcePan = false,
}: PointerInput): Intent {
  if (forcePan) return 'pan';
  if (tool === 'select' || tool === 'pan') return 'native';

  if (tool === 'region') {
    return target === 'image' ? 'draw-region' : 'native';
  }

  // tool === 'edge'
  if (target !== 'image' && target !== 'region') return 'native';
  return pendingSource ? 'edge-target' : 'edge-source';
}

// -- region drawing: a drag between two scene points, held inside the image --

export interface Point {
  x: number;
  y: number;
}

/** Screen slack before an unclaimed press becomes a pan. */
export const POINTER_DRAG_THRESHOLD = 6;

export function movedEnough(from: Point, to: Point): boolean {
  return Math.hypot(to.x - from.x, to.y - from.y) >= POINTER_DRAG_THRESHOLD;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Two drag endpoints -> the rectangle they span, normalised so width/height
 * are never negative regardless of which corner the drag started on. */
export function rectFromDrag(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}
