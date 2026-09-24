// Where each picture sits in the web view: the starting pictures in the
// middle, everything else on rings by how many steps away it is (image-
// graph's hop rings). Deterministic, so walking back to a picture shows
// the same web, and a picture sits near the ones that led to it: each ring
// is ordered by the mean angle of its neighbours on the ring inside it.
/** All the layout reads of a claim: which two pictures it joins. A board
 * row and a report's claim both are one. */
export type LayoutEdge = {
  source: { imageId: string };
  target: { imageId: string };
};

export interface Placed {
  id: string;
  hops: number;
  x: number;
  y: number;
}

/** Room one picture takes on a ring, and the gap between rings. */
export const NODE = 96;
export const RING = 190;

/** Steps from the nearest root, over edges in either direction. */
export function hopsFrom(
  roots: readonly string[],
  ids: readonly string[],
  edges: readonly LayoutEdge[],
): Map<string, number> {
  const around = new Map<string, string[]>();
  for (const e of edges) {
    const a = e.source.imageId;
    const b = e.target.imageId;
    around.set(a, [...(around.get(a) ?? []), b]);
    around.set(b, [...(around.get(b) ?? []), a]);
  }
  const known = new Set(ids);
  const hops = new Map<string, number>();
  let frontier = roots.filter((r) => known.has(r));
  for (const r of frontier) hops.set(r, 0);
  for (let h = 1; frontier.length; h++) {
    const next: string[] = [];
    for (const id of frontier)
      for (const n of around.get(id) ?? [])
        if (known.has(n) && !hops.has(n)) {
          hops.set(n, h);
          next.push(n);
        }
    frontier = next;
  }
  // A picture the edges do not reach still belongs to the answer.
  const far = Math.max(0, ...hops.values()) + 1;
  for (const id of ids) if (!hops.has(id)) hops.set(id, far);
  return hops;
}

/** Positions for the whole web. The part that holds the starting
 * pictures sits at (0, 0); every part not joined to it sits to its right,
 * each laid out around its own busiest picture, so no line crosses from
 * one unconnected part to another (the web of one relation joins several
 * separate pairs; on one set of rings, their lines crossed the middle). */
export function ringLayout(
  roots: readonly string[],
  ids: readonly string[],
  edges: readonly LayoutEdge[],
): Placed[] {
  const parts = components(ids, edges);
  const rooted = new Set(roots);
  // The starting pictures' part first, then the rest by size.
  parts.sort(
    (a, b) =>
      Number(b.some((id) => rooted.has(id))) -
        Number(a.some((id) => rooted.has(id))) ||
      b.length - a.length ||
      (a[0] ?? '').localeCompare(b[0] ?? ''),
  );
  const out: Placed[] = [];
  let right = Number.NEGATIVE_INFINITY;
  for (const part of parts) {
    const inPart = new Set(part);
    const partEdges = edges.filter(
      (e) => inPart.has(e.source.imageId) && inPart.has(e.target.imageId),
    );
    const partRoots = part.filter((id) => rooted.has(id));
    const placed = ringsOf(
      partRoots.length ? partRoots : [busiest(part, partEdges)],
      part,
      partEdges,
    );
    const minX = Math.min(...placed.map((p) => p.x));
    const maxX = Math.max(...placed.map((p) => p.x));
    const shift = Number.isFinite(right) ? right + NODE * 2 - minX : 0;
    for (const p of placed) out.push({ ...p, x: p.x + shift });
    right = maxX + shift;
  }
  return out;
}

/** The parts of the web no edge joins to each other. */
function components(
  ids: readonly string[],
  edges: readonly LayoutEdge[],
): string[][] {
  const known = new Set(ids);
  const around = new Map<string, string[]>();
  for (const e of edges) {
    const a = e.source.imageId;
    const b = e.target.imageId;
    if (!known.has(a) || !known.has(b)) continue;
    around.set(a, [...(around.get(a) ?? []), b]);
    around.set(b, [...(around.get(b) ?? []), a]);
  }
  const seen = new Set<string>();
  const parts: string[][] = [];
  for (const id of [...ids].sort()) {
    if (seen.has(id)) continue;
    const part: string[] = [];
    const stack = [id];
    seen.add(id);
    while (stack.length) {
      const at = stack.pop() as string;
      part.push(at);
      for (const n of around.get(at) ?? [])
        if (!seen.has(n)) {
          seen.add(n);
          stack.push(n);
        }
    }
    parts.push(part.sort());
  }
  return parts;
}

/** The picture with the most edges; ties by id, so the layout is stable. */
function busiest(ids: readonly string[], edges: readonly LayoutEdge[]): string {
  const degree = new Map<string, number>();
  for (const e of edges)
    for (const id of [e.source.imageId, e.target.imageId])
      degree.set(id, (degree.get(id) ?? 0) + 1);
  return [...ids].sort(
    (a, b) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0) || a.localeCompare(b),
  )[0] as string;
}

/** One connected part, on rings around its roots, centred on (0, 0). */
function ringsOf(
  roots: readonly string[],
  ids: readonly string[],
  edges: readonly LayoutEdge[],
): Placed[] {
  const hops = hopsFrom(roots, ids, edges);
  const rings = new Map<number, string[]>();
  for (const id of [...ids].sort()) {
    const h = hops.get(id) ?? 0;
    rings.set(h, [...(rings.get(h) ?? []), id]);
  }
  const neighbours = new Map<string, string[]>();
  for (const e of edges) {
    const a = e.source.imageId;
    const b = e.target.imageId;
    neighbours.set(a, [...(neighbours.get(a) ?? []), b]);
    neighbours.set(b, [...(neighbours.get(b) ?? []), a]);
  }

  const angle = new Map<string, number>();
  const out: Placed[] = [];
  /** The first ring's radius: zero for one starting picture. */
  let base = 0;
  for (const h of [...rings.keys()].sort((p, q) => p - q)) {
    const ring = rings.get(h) ?? [];
    // Order by where the ones that led here sit, so lines stay short.
    const wanted = (id: string) => {
      const inner = (neighbours.get(id) ?? []).filter(
        (n) => (hops.get(n) ?? 0) < h && angle.has(n),
      );
      if (!inner.length) return Number.POSITIVE_INFINITY;
      let sx = 0;
      let sy = 0;
      for (const n of inner) {
        sx += Math.cos(angle.get(n) as number);
        sy += Math.sin(angle.get(n) as number);
      }
      return Math.atan2(sy, sx);
    };
    const ordered = [...ring].sort((a, b) => wanted(a) - wanted(b));
    if (h === 0 && ordered.length === 1) {
      const only = ordered[0] as string;
      angle.set(only, 0);
      out.push({ id: only, hops: 0, x: 0, y: 0 });
      continue;
    }
    // Several starting pictures sit side by side on the first ring; every
    // later ring lies outside it, and grows until its pictures fit around
    // it without touching.
    const radius =
      h === 0
        ? Math.max(NODE, (ordered.length * NODE) / (2 * Math.PI))
        : Math.max(
            base + h * RING,
            (ordered.length * NODE * 1.15) / (2 * Math.PI),
          );
    if (h === 0) base = radius;
    const start = ordered.length ? wanted(ordered[0] as string) : 0;
    const offset =
      h === 0 ? Math.PI : Number.isFinite(start) ? start : -Math.PI / 2;
    ordered.forEach((id, i) => {
      const a = offset + (i / ordered.length) * 2 * Math.PI;
      angle.set(id, a);
      out.push({
        id,
        hops: h,
        x: Math.round(Math.cos(a) * radius),
        y: Math.round(Math.sin(a) * radius),
      });
    });
  }
  return out;
}
