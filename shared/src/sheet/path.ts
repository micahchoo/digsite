// How two pictures are connected: the shortest chain of claims between
// them, across every sheet on the board (image-graph's `tracePath`, over
// the board's union of claims). Pure: rows in, steps out.
// One definition for the board's path panel and a path report
// (report scope "path", server/src/reports/gather.ts).
//
// Fewest steps first. Between chains of the same length, the more certain
// one: a confirmed step costs less than a likely one, which costs less
// than an unverified or unstated one, but never as much as a whole step.
import type { EdgeRow } from './claims.ts';

export interface PathStep {
  from: string;
  to: string;
  edge: EdgeRow;
  /** True when the step walks the edge from its source to its target. */
  forward: boolean;
  /** Other claims on the same pair of pictures, from any sheet. */
  others: number;
}

const DOUBT: Record<string, number> = {
  confirmed: 0,
  likely: 0.01,
  unverified: 0.02,
};
const UNSTATED = 0.03;

const cost = (edge: EdgeRow) =>
  1 + (edge.confidence ? (DOUBT[edge.confidence] ?? UNSTATED) : UNSTATED);

/** The chain from `from` to `to`, or null when the rows hold none. The
 * empty chain when they are the same picture. */
export function shortestPath(
  edges: readonly EdgeRow[],
  from: string,
  to: string,
): PathStep[] | null {
  if (from === to) return [];
  const around = new Map<string, EdgeRow[]>();
  const pairCount = new Map<string, number>();
  const seen = new Set<string>();
  for (const edge of edges) {
    if (seen.has(edge.id)) continue;
    seen.add(edge.id);
    const a = edge.source.imageId;
    const b = edge.target.imageId;
    if (a === b) continue;
    for (const end of [a, b]) {
      const list = around.get(end) ?? [];
      list.push(edge);
      around.set(end, list);
    }
    const pair = a < b ? `${a}|${b}` : `${b}|${a}`;
    pairCount.set(pair, (pairCount.get(pair) ?? 0) + 1);
  }

  // Dijkstra over at most a few hundred pictures: a plain scan for the
  // nearest open node costs less than keeping a heap.
  const best = new Map<string, number>([[from, 0]]);
  const via = new Map<string, EdgeRow>();
  const done = new Set<string>();
  for (;;) {
    let node: string | null = null;
    let nodeCost = Number.POSITIVE_INFINITY;
    for (const [id, c] of best)
      if (!done.has(id) && c < nodeCost) {
        node = id;
        nodeCost = c;
      }
    if (node === null) return null;
    if (node === to) break;
    done.add(node);
    for (const edge of around.get(node) ?? []) {
      const next =
        edge.source.imageId === node
          ? edge.target.imageId
          : edge.source.imageId;
      const c = nodeCost + cost(edge);
      if (c < (best.get(next) ?? Number.POSITIVE_INFINITY)) {
        best.set(next, c);
        via.set(next, edge);
      }
    }
  }

  const steps: PathStep[] = [];
  for (let at = to; at !== from; ) {
    const edge = via.get(at);
    if (!edge) return null;
    const prev =
      edge.source.imageId === at ? edge.target.imageId : edge.source.imageId;
    const pair = prev < at ? `${prev}|${at}` : `${at}|${prev}`;
    steps.push({
      from: prev,
      to: at,
      edge,
      forward: edge.source.imageId === prev,
      others: (pairCount.get(pair) ?? 1) - 1,
    });
    at = prev;
  }
  return steps.reverse();
}
