import { describe, expect, test } from 'bun:test';
import { type NeighbourhoodItem, ringLayout } from '../src/sheet/layout.ts';

function pairs<T>(arr: T[]): [T, T][] {
  const out: [T, T][] = [];
  for (let i = 0; i < arr.length; i++) {
    for (let j = i + 1; j < arr.length; j++) {
      const a = arr[i];
      const b = arr[j];
      if (a !== undefined && b !== undefined) out.push([a, b]);
    }
  }
  return out;
}

/** Two `cell`-side axis-aligned boxes centred at `a`/`b` overlap iff
 * `|dx| < cell AND |dy| < cell`. */
function overlaps(
  a: { x: number; y: number },
  b: { x: number; y: number },
  cell: number,
): boolean {
  return Math.abs(a.x - b.x) < cell && Math.abs(a.y - b.y) < cell;
}

describe('ringLayout', () => {
  test('empty input', () => {
    expect(ringLayout([]).size).toBe(0);
  });

  test('a single hop-0 item sits at the origin', () => {
    const positions = ringLayout([{ id: 'a', hops: 0 }]);
    expect(positions.get('a')).toEqual({ x: 0, y: 0 });
  });

  test('deterministic: the same input lays out the same way twice', () => {
    const items: NeighbourhoodItem[] = [
      { id: 'a', hops: 0 },
      { id: 'b', hops: 1 },
      { id: 'c', hops: 1 },
      { id: 'd', hops: 2 },
    ];
    const p1 = ringLayout(items);
    const p2 = ringLayout(items.map((i) => ({ ...i })));
    expect(Array.from(p1.entries())).toEqual(Array.from(p2.entries()));
  });

  test('rings by hop: distance from the origin is non-decreasing in hops', () => {
    const items: NeighbourhoodItem[] = [
      { id: 'a', hops: 0 },
      { id: 'b1', hops: 1 },
      { id: 'b2', hops: 1 },
      { id: 'b3', hops: 1 },
      { id: 'c1', hops: 2 },
      { id: 'c2', hops: 2 },
      { id: 'd1', hops: 3 },
    ];
    const positions = ringLayout(items);
    const distByHop = new Map<number, number>();
    for (const item of items) {
      const p = positions.get(item.id);
      if (!p) throw new Error(`missing position for ${item.id}`);
      const d = Math.hypot(p.x, p.y);
      const known = distByHop.get(item.hops);
      // every item at the same hop count is the same distance out (one
      // ring per hop) — rounding each coordinate independently can move
      // the computed distance by a little over a pixel, so compare loosely
      if (known !== undefined) expect(Math.abs(d - known)).toBeLessThan(2);
      else distByHop.set(item.hops, d);
    }
    const hops = Array.from(distByHop.keys()).sort((a, b) => a - b);
    for (let i = 1; i < hops.length; i++) {
      const prevHop = hops[i - 1];
      const hop = hops[i];
      if (prevHop === undefined || hop === undefined) continue;
      const prev = distByHop.get(prevHop);
      const cur = distByHop.get(hop);
      if (prev === undefined || cur === undefined) continue;
      expect(cur).toBeGreaterThan(prev);
    }
  });

  test('items within a ring are evenly spaced (equal distance from the origin)', () => {
    const items: NeighbourhoodItem[] = [
      { id: 'a', hops: 0 },
      { id: 'b1', hops: 1 },
      { id: 'b2', hops: 1 },
      { id: 'b3', hops: 1 },
      { id: 'b4', hops: 1 },
    ];
    const positions = ringLayout(items);
    const ring1 = ['b1', 'b2', 'b3', 'b4'].map((id) => {
      const p = positions.get(id);
      if (!p) throw new Error(`missing ${id}`);
      return p;
    });
    const radii = ring1.map((p) => Math.hypot(p.x, p.y));
    for (const r of radii)
      expect(Math.abs(r - (radii[0] ?? 0))).toBeLessThan(2);
  });

  test('overlap-free for 150 items across four hop levels', () => {
    const items: NeighbourhoodItem[] = [{ id: 'origin', hops: 0 }];
    // spread the remaining 149 items roughly evenly across hops 1..3
    const counts = [50, 50, 49];
    for (let hop = 1; hop <= 3; hop++) {
      const count = counts[hop - 1] ?? 0;
      for (let i = 0; i < count; i++) {
        items.push({ id: `h${hop}-${i}`, hops: hop });
      }
    }
    expect(items.length).toBe(150);

    const cell = 320;
    const positions = ringLayout(items, cell);
    expect(positions.size).toBe(150);

    const all = Array.from(positions.entries()).map(([id, p]) => ({
      id,
      ...p,
    }));
    for (const [a, b] of pairs(all)) {
      expect(overlaps(a, b, cell)).toBe(false);
    }
  });

  test('a custom cell size is honoured', () => {
    const items: NeighbourhoodItem[] = [
      { id: 'a', hops: 0 },
      { id: 'b', hops: 1 },
    ];
    const small = ringLayout(items, 100);
    const big = ringLayout(items, 1000);
    const rSmall = Math.hypot(small.get('b')?.x ?? 0, small.get('b')?.y ?? 0);
    const rBig = Math.hypot(big.get('b')?.x ?? 0, big.get('b')?.y ?? 0);
    expect(rBig).toBeGreaterThan(rSmall);
  });
});
