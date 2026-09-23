// Hop rings for the web view (board/web-layout.ts).
import { describe, expect, test } from 'bun:test';
import type { EdgeRow } from '@digsite/shared';
import { NODE, hopsFrom, ringLayout } from '../src/board/web-layout.ts';

let n = 0;
const e = (a: string, b: string): EdgeRow => ({
  id: `e${n++}`,
  sheetId: 's',
  sourceId: 'x',
  source: { imageId: a } as EdgeRow['source'],
  target: { imageId: b } as EdgeRow['target'],
  direction: 'forward',
  relation: 'r',
  properties: {},
  confidence: null,
  note: '',
});

const edges = [e('R', 'A'), e('B', 'R'), e('A', 'C'), e('B', 'D')];
const ids = ['R', 'A', 'B', 'C', 'D', 'Z'];

describe('hopsFrom', () => {
  test('counts steps from the nearest root, either direction', () => {
    const hops = hopsFrom(['R'], ids, edges);
    expect(Object.fromEntries(hops)).toEqual({
      R: 0,
      A: 1,
      B: 1,
      C: 2,
      D: 2,
      Z: 3,
    });
  });
  test('several roots: the nearer one counts', () => {
    expect(hopsFrom(['C', 'D'], ids, edges).get('R')).toBe(2);
  });
});

describe('ringLayout', () => {
  const placed = new Map(ringLayout(['R'], ids, edges).map((p) => [p.id, p]));
  test('the root sits in the middle, the rest on rings by hops', () => {
    expect(placed.get('R')).toMatchObject({ x: 0, y: 0 });
    const r = (id: string) =>
      Math.hypot(placed.get(id)?.x ?? 0, placed.get(id)?.y ?? 0);
    expect(r('A')).toBeCloseTo(r('B'), 0);
    expect(r('C')).toBeGreaterThan(r('A'));
  });
  test('a picture sits near the one that led to it', () => {
    const d = (a: string, b: string) =>
      Math.hypot(
        (placed.get(a)?.x ?? 0) - (placed.get(b)?.x ?? 0),
        (placed.get(a)?.y ?? 0) - (placed.get(b)?.y ?? 0),
      );
    expect(d('C', 'A')).toBeLessThan(d('C', 'B'));
    expect(d('D', 'B')).toBeLessThan(d('D', 'A'));
  });
  test('no two pictures on one ring touch', () => {
    const many = Array.from({ length: 40 }, (_, i) => `n${i}`);
    const star = many.map((id) => e('R', id));
    const ring = ringLayout(['R'], ['R', ...many], star).filter(
      (p) => p.hops === 1,
    );
    for (let i = 0; i < ring.length; i++)
      for (let j = i + 1; j < ring.length; j++) {
        const a = ring[i];
        const b = ring[j];
        if (a && b)
          expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(
            NODE - 1,
          );
      }
  });
  test('the same answer lays out the same way', () => {
    expect(ringLayout(['R'], ids, edges)).toEqual(
      ringLayout(['R'], [...ids].reverse(), edges),
    );
  });
});

describe('parts no edge joins', () => {
  // Found on the claims walk: "same place" joins 4-5 and 10-11. On one set
  // of rings the 4-5 line crossed the middle and its label sat on 10-11's.
  test('sit side by side, and no line crosses from one to the other', () => {
    const pairs = [e('A', 'B'), e('C', 'D')];
    const placed = new Map(
      ringLayout(['A'], ['A', 'B', 'C', 'D'], pairs).map((p) => [p.id, p]),
    );
    const x = (id: string) => placed.get(id)?.x ?? 0;
    // A's part is at the origin; C and D sit wholly to its right.
    expect(Math.min(x('C'), x('D'))).toBeGreaterThan(Math.max(x('A'), x('B')));
    // Each part keeps its own rings: C-D as close as A-B.
    const len = (a: string, b: string) =>
      Math.hypot(
        x(a) - x(b),
        (placed.get(a)?.y ?? 0) - (placed.get(b)?.y ?? 0),
      );
    expect(len('C', 'D')).toBeCloseTo(len('A', 'B'), 0);
  });
});
