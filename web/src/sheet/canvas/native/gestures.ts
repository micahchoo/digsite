// Ported from research/image-graph/src/gestures.ts: "what a pointer is
// asking for" as one pure decision, no DOM, no camera, no scene. Narrowed
// to the two tools the native canvas itself ever sees pointer events for —
// 'select' and 'pan' — because DrawLayer.tsx (../../DrawLayer.tsx) is a
// full-bleed sibling that captures every pointer
// event itself while the active tool is 'region' or 'edge', so this canvas
// never receives one in that state.
export type Mode = 'select' | 'pan';
export type Target = 'image' | 'region' | 'edge' | 'empty';

/** Screen pixels a pointer must travel before a press becomes a drag rather
 * than a click. Same threshold image-graph settled on. */
export const DRAG_THRESHOLD = 6;

export function movedEnough(
  from: { x: number; y: number },
  to: { x: number; y: number },
  threshold = DRAG_THRESHOLD,
): boolean {
  return Math.hypot(to.x - from.x, to.y - from.y) >= threshold;
}

export interface PressInput {
  mode: Mode;
  /** Space is held, or the middle button — pans from anywhere. */
  forcePan: boolean;
  button: number;
  /** The press landed on a grip of the selected region. */
  onGrip: boolean;
}

/** What a press sets up before anything moves. A grip takes the press only
 * in Select, with the primary button, and only when nothing is forcing a
 * pan. */
export function pressIntent(input: PressInput): 'handle' | 'plain' {
  const primary = input.button === 0 && !input.forcePan;
  if (input.onGrip && primary && input.mode === 'select') return 'handle';
  return 'plain';
}

export interface DragInput {
  /** Space, or the middle button. */
  forcePan: boolean;
  /** What the press landed on. A connection cannot be dragged: it pans. */
  over: Target;
  mode: Mode;
}

/**
 * What a press becomes once it has moved far enough — total over every
 * combination, `pan` the answer to everything unclaimed (image-graph's own
 * rule: an unrecognised drag on a map must move the map, never do
 * nothing).
 */
export function dragBecomes(input: DragInput): 'pan' | 'move' | 'marquee' {
  if (input.forcePan || input.mode === 'pan') return 'pan';
  if (input.over === 'image' || input.over === 'region') return 'move';
  return 'marquee';
}
