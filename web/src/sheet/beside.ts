// Where a picture made from a region goes: next to the picture it came
// from, on the first side that touches nothing (image-graph's extraction
// places it the same way). Right, then below, left, above.

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const GAP = 48;

const touches = (a: Rect, b: Rect) =>
  a.x < b.x + b.width + GAP / 2 &&
  b.x < a.x + a.width + GAP / 2 &&
  a.y < b.y + b.height + GAP / 2 &&
  b.y < a.y + a.height + GAP / 2;

/** The top-left corner for a `size` picture beside `parent`, or null when
 * every side is taken. */
export function besideSpot(
  parent: Rect,
  size: { width: number; height: number },
  others: readonly Rect[],
): { x: number; y: number } | null {
  const centreY = parent.y + (parent.height - size.height) / 2;
  const centreX = parent.x + (parent.width - size.width) / 2;
  const spots = [
    { x: parent.x + parent.width + GAP, y: centreY },
    { x: centreX, y: parent.y + parent.height + GAP },
    { x: parent.x - GAP - size.width, y: centreY },
    { x: centreX, y: parent.y - GAP - size.height },
  ];
  return (
    spots.find((spot) => {
      // Only the size: `size` is often the element itself, whose own x and
      // y would otherwise replace the spot being tried.
      const box = { ...spot, width: size.width, height: size.height };
      return !others.some((other) => touches(box, other));
    }) ?? null
  );
}
