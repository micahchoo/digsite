// The ladder: an image's pixels, keyed by slot (never rank — see
// ../../.claude/rules/ladder-slot-vs-rank.md). Sizes are packed into 512px
// atlas pages so a page is one file, one read, one lock.

export const LADDER = [8, 32, 128] as const;
export type LadderSize = (typeof LADDER)[number];
export const PAGE = 512;

/** Images per page at size s: the page divided into s-sized squares. */
export function perPage(s: LadderSize): number {
  const side = PAGE / s;
  return side * side;
}

/** Which page a slot lands on, and where in that page. */
export function ladderAddress(
  slot: number,
  s: LadderSize,
): { page: number; x: number; y: number } {
  const perRow = PAGE / s;
  const capacity = perPage(s);
  const page = Math.floor(slot / capacity);
  const i = slot % capacity;
  return { page, x: (i % perRow) * s, y: Math.floor(i / perRow) * s };
}

/** The smallest ladder size at least cellPx, or 128 if none reaches it. */
export function sizeFor(cellPx: number): LadderSize {
  for (const s of LADDER) {
    if (s >= cellPx) return s;
  }
  return 128;
}
