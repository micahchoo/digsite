import { describe, expect, test } from 'bun:test';
import type { Reach, ReachEdge } from '@digsite/shared';
import { leadsByImage } from '../src/sheet/overlay/Reach.tsx';

const edge = (
  id: string,
  source: string,
  target: string,
  near: 'source' | 'target',
  relation: string,
): ReachEdge => ({
  id,
  sheetId: 'other',
  sourceId: id,
  source: { imageId: source },
  target: { imageId: target },
  direction: 'forward',
  relation,
  properties: {},
  confidence: null,
  note: '',
  sheetName: 'Other',
  near,
});
const image = (id: string) => ({
  id,
  name: id,
  width: 1,
  height: 1,
  missing: false,
});

describe('leadsByImage', () => {
  test('groups reach by the image here, then by the far image', () => {
    const rows: Reach = {
      edges: [
        edge('e1', 'A', 'X', 'source', 'same place'),
        edge('e2', 'Y', 'A', 'target', 'derived from'),
        edge('e3', 'A', 'X', 'source', 'resembles'),
        edge('e4', 'B', 'X', 'source', 'same place'),
      ],
      images: [image('X'), image('Y')],
    };
    const leads = leadsByImage(rows);
    expect(
      leads.get('A')?.map((l) => [l.image.id, l.edges.map((e) => e.relation)]),
    ).toEqual([
      ['X', ['same place', 'resembles']],
      ['Y', ['derived from']],
    ]);
    expect(leads.get('B')?.map((l) => l.image.id)).toEqual(['X']);
  });

  test('an edge whose far image did not come back is left out', () => {
    const leads = leadsByImage({
      edges: [edge('e1', 'A', 'Z', 'source', 'same place')],
      images: [],
    });
    expect(leads.size).toBe(0);
  });
});
