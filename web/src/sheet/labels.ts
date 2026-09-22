// A region's bound label: a FIXED width from the region's own rect, never
// from the text (docs/phases/2-sheet.md section 1 — "a label must never
// resize its region"). `tools.ts#drawRegion` passes `regionLabelWidth`'s
// result as the bound text's `width` with `autoResize: false`, so Excalidraw
// never grows the container to fit long text (see
// research/excalidraw/packages/element/src/textElement.ts —
// `handleBindTextResize`'s early return when `!container.autoResize` was
// where this held before it happened in the running app). Long text is
// truncated to an ellipsis by US, in the string that becomes the bound
// text's content, rather than relying on Excalidraw to clip or wrap it.

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
