// Ported from research/image-graph/src/gestures.ts: "what a pointer is
// asking for" as one pure decision, no DOM, no camera, no scene. DrawLayer
// routes its authoring-tool fallback gestures through the same decisions.
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

/** A normal click replaces selection; Shift-click toggles one element. */
export function selectionAfterClick(
  selected: readonly string[],
  hitId: string | null,
  additive: boolean,
): string[] {
  if (!additive) return hitId ? [hitId] : [];
  if (!hitId) return [...selected];
  return selected.includes(hitId)
    ? selected.filter((id) => id !== hitId)
    : [...selected, hitId];
}

/** A Shift-marquee adds its hits to the current selection without duplicates. */
export function selectionAfterMarquee(
  selected: readonly string[],
  hits: readonly string[],
  additive: boolean,
): string[] {
  return additive ? [...new Set([...selected, ...hits])] : [...hits];
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
 * nothing). Shift-marquee is decided before this function is called.
 */
export function dragBecomes(input: DragInput): 'pan' | 'move' {
  if (input.forcePan || input.mode === 'pan') return 'pan';
  if (input.over === 'image' || input.over === 'region') return 'move';
  return 'pan';
}
