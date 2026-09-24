// How two pictures are connected (shared/sheet/path.ts).
import { describe, expect, test } from 'bun:test';
import type { EdgeRow } from '../src/sheet/claims.ts';
import { shortestPath } from '../src/sheet/path.ts';

let n = 0;
const edge = (
  a: string,
  b: string,
  relation: string,
  confidence: EdgeRow['confidence'] = null,
): EdgeRow => ({
  id: `e${n++}`,
  sheetId: 's',
  sourceId: `el${n}`,
  source: { imageId: a } as EdgeRow['source'],
  target: { imageId: b } as EdgeRow['target'],
  direction: 'forward',
  relation,
  properties: {},
  confidence,
  note: '',
});

describe('shortestPath', () => {
  test('walks edges in either direction, fewest steps first', () => {
    const rows = [
      edge('A', 'B', 'same place'),
      edge('C', 'B', 'resembles'),
      edge('A', 'X', 'x'),
      edge('X', 'Y', 'y'),
      edge('Y', 'C', 'z'),
    ];
    const path = shortestPath(rows, 'A', 'C');
    expect(path?.map((s) => [s.from, s.edge.relation, s.to])).toEqual([
      ['A', 'same place', 'B'],
      ['B', 'resembles', 'C'],
    ]);
    expect(path?.map((s) => s.forward)).toEqual([true, false]);
  });

  test('between chains of equal length, the more certain one', () => {
    const rows = [
      edge('A', 'M', 'maybe', 'unverified'),
      edge('M', 'B', 'maybe', 'unverified'),
      edge('A', 'N', 'sure', 'confirmed'),
      edge('N', 'B', 'sure', 'confirmed'),
    ];
    expect(shortestPath(rows, 'A', 'B')?.map((s) => s.to)).toEqual(['N', 'B']);
  });

  test('never trades a step for certainty', () => {
    const rows = [
      edge('A', 'B', 'direct', 'unverified'),
      edge('A', 'N', 'sure', 'confirmed'),
      edge('N', 'B', 'sure', 'confirmed'),
    ];
    expect(shortestPath(rows, 'A', 'B')).toHaveLength(1);
  });

  test('counts the other claims on a step’s pair', () => {
    const rows = [
      edge('A', 'B', 'same place'),
      edge('B', 'A', 'different place'),
    ];
    expect(shortestPath(rows, 'A', 'B')?.[0]?.others).toBe(1);
  });

  test('no chain, no answer; the same picture, an empty chain', () => {
    expect(shortestPath([edge('A', 'B', 'x')], 'A', 'Z')).toBeNull();
    expect(shortestPath([], 'A', 'A')).toEqual([]);
  });
});
