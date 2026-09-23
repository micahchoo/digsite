import { describe, expect, test } from 'bun:test';
import type { ForeignEdge } from '@digsite/shared';
import {
  claimsOnPair,
  cropStyle,
  foreignEvidence,
  ownEvidence,
  ownPairEdges,
} from '../src/sheet/evidence.ts';

const image = (id: string, imageId: string, x: number) => ({
  id,
  x,
  y: 0,
  width: 200,
  height: 100,
  customData: { kind: 'image', imageId },
});
const region = (id: string, imageId: string, x: number, label: string) => ({
  id,
  x,
  y: 25,
  width: 50,
  height: 50,
  customData: { kind: 'region', imageId, label, properties: {} },
});
const edge = (
  id: string,
  from: string,
  to: string,
  relation: string,
  extra: Record<string, unknown> = {},
) => ({
  id,
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  startBinding: { elementId: from },
  endBinding: { elementId: to },
  customData: {
    kind: 'edge',
    relation,
    direction: 'forward',
    properties: {},
    ...extra,
  },
});

const scene = [
  image('ia', 'A', 0),
  image('ib', 'B', 300),
  region('ra', 'A', 50, 'roofline'),
  edge('e1', 'ra', 'ib', 'same place', {
    confidence: 'likely',
    note: 'chimney',
  }),
  edge('e2', 'ib', 'ia', 'different place'),
];

describe('evidence', () => {
  test('a region end is its fraction of the image; an image end is whole', () => {
    const ends = ownEvidence(scene[3] as never, scene);
    expect(ends?.[0]).toEqual({
      imageId: 'A',
      imageSize: { width: 200, height: 100 },
      fraction: { fx: 0.25, fy: 0.25, fw: 0.25, fh: 0.5 },
      label: 'roofline',
    });
    expect(ends?.[1]).toMatchObject({
      imageId: 'B',
      fraction: null,
      label: null,
    });
  });

  test("a foreign edge finds its region among that sheet's rows", () => {
    const row = {
      id: 'other:e9',
      sheetId: 'other',
      sourceId: 'e9',
      source: { imageId: 'A', regionSourceId: 'r9' },
      target: { imageId: 'B' },
      direction: 'forward',
      relation: 'same place',
      properties: {},
      confidence: null,
      note: '',
      sheetName: 'Other',
    } satisfies ForeignEdge;
    const [a] = foreignEvidence(
      row,
      [
        {
          id: 'other:r9',
          sheetId: 'other',
          sourceId: 'r9',
          imageId: 'A',
          fx: 0.1,
          fy: 0.2,
          fw: 0.3,
          fh: 0.4,
          label: 'door',
          properties: {},
          sheetName: 'Other',
        },
      ],
      scene,
    );
    expect(a).toMatchObject({ fraction: { fx: 0.1, fw: 0.3 }, label: 'door' });
  });

  test("a crop box keeps the region's proportions and shows exactly it", () => {
    const [a] = ownEvidence(scene[3] as never, scene) ?? [];
    if (!a) throw new Error('no end');
    // 0.25 x 200 = 50 wide, 0.5 x 100 = 50 tall: square.
    const style = cropStyle(a, 'x.png', 120);
    expect(style).toMatchObject({
      width: 120,
      height: 120,
      backgroundSize: '400% 200%',
      backgroundPosition: '33.33333333333333% 50%',
    });
  });
});

describe('claims on a pair', () => {
  test('lists other claims on the same pair, with agreement', () => {
    const own = ownPairEdges(scene);
    const subject = own.find((e) => e.id === 'e1');
    if (!subject) throw new Error('no subject');
    const foreign: ForeignEdge[] = [
      {
        id: 'other:e9',
        sheetId: 'other',
        sourceId: 'e9',
        source: { imageId: 'B' },
        target: { imageId: 'A' },
        direction: 'reverse',
        relation: 'same location',
        properties: {},
        confidence: 'confirmed',
        note: '',
        sheetName: 'Faces',
      },
    ];
    const claims = claimsOnPair(
      subject,
      own,
      foreign,
      { 'same location': 'same place' },
      'First pass',
    );
    // A foreign claim is selected by the overlay's shape id, not its row id.
    expect(claims.find((c) => !c.own)?.id).toBe('edge-other:e9');
    expect(claims.map((c) => [c.sheetName, c.relation, c.agreement])).toEqual([
      ['First pass', 'different place', 'disagree'],
      ['Faces', 'same location', 'agree'],
    ]);
  });
});
