// A region's bound label: a FIXED width from the region's own rect, never
// from the text (docs/phases/2-sheet.md section 1 — "a label must never
// resize its region"). `tools.ts#drawRegion` passes `regionLabelWidth`'s
// result as the bound text's `width`, so long text never grows the container.
// Long text is
// truncated to an ellipsis by US, in the string that becomes the bound
// text's content rather than relying on the canvas to clip or wrap it.

export const LABEL_MAX_CHARS = 40;
export const MIN_LABEL_WIDTH = 40;

/** The region rect's own width, floored so a sliver of a region still gets
 * a readable label box. Never a function of the label string. */
export function regionLabelWidth(rect: { width: number }): number {
  return Math.max(MIN_LABEL_WIDTH, rect.width);
}

/** Single-line, ellipsis-truncated at `max` characters. Deterministic and
 * independent of any measured pixel width — a 200-character label always
 * comes back the same length. */
export function truncateLabel(label: string, max = LABEL_MAX_CHARS): string {
  if (label.length <= max) return label;
  if (max <= 1) return '…';
  return `${label.slice(0, max - 1)}…`;
}

/** What a region is called, as drawn. The native canvas keeps the label in
 * `customData.label`; a scene saved by the former canvas kept it in a bound
 * text element instead, so that is the fallback. */
export function regionLabelOf(
  region: {
    customData?: unknown;
    boundElements?: readonly { id: string; type: string }[] | null;
  },
  byId: ReadonlyMap<string, { text?: string }>,
): string {
  const data = region.customData as { label?: unknown } | undefined;
  if (typeof data?.label === 'string' && data.label) return data.label;
  const textId = region.boundElements?.find((b) => b.type === 'text')?.id;
  return (textId ? byId.get(textId)?.text : undefined) ?? '';
}

/** Where a region's label chip sits on screen: just above the region's
 * top-left corner, as wide as its text. `canvas/native/render.ts` draws it
 * here and `overlay/Overlay.tsx` keeps other labels off it; both ask this. */
export function regionChip(
  screen: { x: number; y: number },
  textWidth: number,
): { x: number; y: number; width: number; height: number } {
  return { x: screen.x, y: screen.y - 18, width: textWidth + 8, height: 16 };
}
