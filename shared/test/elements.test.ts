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
});
