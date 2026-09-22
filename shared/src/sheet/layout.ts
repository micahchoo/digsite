// Sheet-from-a-neighbourhood's layout (docs/phases/2-sheet.md section 4):
// rings by hop count around the image the neighbourhood was explored from.
// Pure and deterministic — the same `items` array always produces the same
// positions — so it is tested here with no server, no Excalidraw, no DOM.
//
// A position is the CENTRE of an item's `cell`-sized box (matching
// server/src/sheets/routes.ts's own CELL=320 grid layout, which centres
// each image inside its cell too): `POST /boards/:id/sheets` turns a centre
// into a top-left by subtracting half the image's own scaled width/height.

export type NeighbourhoodItem = { id: string; hops: number };

/** The minimum centre-to-centre distance that guarantees two `cell`-side
 * axis-aligned boxes never overlap. Two boxes overlap iff `|dx| < cell AND
 * |dy| < cell`; forcing the Euclidean distance to at least `cell * sqrt(2)`
 * forces the Chebyshev distance (`max(|dx|, |dy|)`) to at least `cell`,
 * which is exactly the "don't overlap" condition. */
function minSpacing(cell: number): number {
  return cell * Math.SQRT2;
}

/** The radius at which `n` points evenly spaced around a circle are at
 * least `spacing` apart (adjacent points are the closest pair on a ring, at
 * chord length `2r·sin(π/n)`). `n <= 1` has no adjacent pair, so it only
 * has to clear whatever ring sits inside it — the caller adds that. */
function ringRadius(n: number, spacing: number): number {
  if (n <= 1) return spacing;
  return spacing / (2 * Math.sin(Math.PI / n));
}

/**
 * Lays `items` out in concentric rings, one ring per distinct `hops` value,
 * ordered nearest-first from the origin. A single hop-0 item (the
 * neighbourhood's `from` image, the overwhelmingly common case) sits
 * exactly at the origin; everything else is placed evenly around its
 * ring, deterministically, first item at angle 0.
 *
 * Overlap-free for any `items.length`: each ring's radius is the larger of
 * (a) what its own point count needs and (b) the previous ring's radius
 * plus one `cell`, so consecutive rings never interleave. Tested up to 150
 * items (`shared/sheet/elements.ts#SHEET_LIMIT`) in layout.test.ts.
 */
export function ringLayout(
  items: NeighbourhoodItem[],
  cell = 320,
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  if (items.length === 0) return positions;

  const spacing = minSpacing(cell);

  // Stable grouping by hop count — items keep their relative order within
  // a ring, so the same input array always lays out the same way.
  const byHop = new Map<number, NeighbourhoodItem[]>();
  for (const item of items) {
    const ring = byHop.get(item.hops);
    if (ring) ring.push(item);
    else byHop.set(item.hops, [item]);
  }
  const hopLevels = Array.from(byHop.keys()).sort((a, b) => a - b);

  let previousRadius = 0;
  for (const hop of hopLevels) {
    const ring = byHop.get(hop);
    if (!ring) continue;

    const first = ring[0];
    if (hop === hopLevels[0] && ring.length === 1 && first) {
      // The origin. previousRadius stays 0, so the next ring still clears
      // it by a full `spacing`.
      positions.set(first.id, { x: 0, y: 0 });
      continue;
    }

    const n = ring.length;
    const radius = Math.max(ringRadius(n, spacing), previousRadius + spacing);
    ring.forEach((item, i) => {
      const theta = (2 * Math.PI * i) / n;
      positions.set(item.id, {
        x: Math.round(radius * Math.cos(theta)),
        y: Math.round(radius * Math.sin(theta)),
      });
    });
    previousRadius = radius;
  }

  return positions;
}
