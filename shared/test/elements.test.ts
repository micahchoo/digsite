import { describe, expect, test } from 'bun:test';
import {
  type Direction,
  arrowheadsFor,
  dataOf,
  directionOf,
} from '../src/sheet/elements.ts';

describe('arrowheadsFor / directionOf', () => {
  test('inverse for all four directions', () => {
    const directions: Direction[] = ['none', 'forward', 'reverse', 'both'];
    for (const d of directions) {
      const { startArrowhead, endArrowhead } = arrowheadsFor(d);
      expect(directionOf(startArrowhead, endArrowhead)).toBe(d);
    }
  });
});

describe('dataOf', () => {
  test('rejects a missing kind', () => {
    expect(dataOf({ customData: {} })).toBeNull();
  });

  test('rejects a wrong kind', () => {
    expect(dataOf({ customData: { kind: 'foreign' } })).toBeNull();
  });

  test('rejects a region without imageId', () => {
    expect(
      dataOf({ customData: { kind: 'region', label: 'x', properties: {} } }),
    ).toBeNull();
  });

  test('accepts a valid image', () => {
    expect(dataOf({ customData: { kind: 'image', imageId: 'i1' } })).toEqual({
      kind: 'image',
      imageId: 'i1',
    });
  });

  test('accepts a valid region', () => {
    expect(
      dataOf({
        customData: {
          kind: 'region',
          imageId: 'i1',
          label: 'face',
          properties: { year: 1990 },
        },
      }),
    ).toEqual({
      kind: 'region',
      imageId: 'i1',
      label: 'face',
      properties: { year: 1990 },
    });
  });

  test('accepts a valid edge', () => {
    expect(
      dataOf({
        customData: {
          kind: 'edge',
          relation: 'resembles',
          direction: 'forward',
          properties: {},
        },
      }),
    ).toEqual({
      kind: 'edge',
      relation: 'resembles',
      direction: 'forward',
      properties: {},
    });
  });

  test('an edge carries its confidence and note, and a scene saved before them still reads', () => {
    const edge = (extra: Record<string, unknown>) =>
      dataOf({
        customData: {
          kind: 'edge',
          relation: 'same place',
          direction: 'none',
          properties: {},
          ...extra,
        },
      });
    expect(edge({ confidence: 'likely', note: 'same roofline' })).toEqual({
      kind: 'edge',
      relation: 'same place',
      direction: 'none',
      properties: {},
      confidence: 'likely',
      note: 'same roofline',
    });
    expect(edge({})).not.toBeNull();
    expect(edge({ confidence: 'certain' })).toBeNull();
    expect(edge({ note: 42 })).toBeNull();
  });
});

describe('stamps: who made a claim and who changed it', () => {
  const made = { id: 'u1', name: 'Micah', at: '2026-09-23T01:00:00.000Z' };
  test('a stamp is carried through dataOf, so an edit keeps it', () => {
    const data = dataOf({
      customData: {
        kind: 'edge',
        relation: 'same place',
        direction: 'forward',
        properties: {},
        made,
      },
    });
    expect(data).toMatchObject({ made });
  });
  test('a malformed stamp is dropped and the claim stands', () => {
    const data = dataOf({
      customData: {
        kind: 'region',
        imageId: 'i',
        label: 'x',
        properties: {},
        made: { id: 7 },
      },
    });
    expect(data).not.toBeNull();
    expect(data && 'made' in data).toBe(false);
  });
});
