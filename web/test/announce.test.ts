import { describe, expect, test } from 'bun:test';
import { describeSelection } from '../src/sheet/announce.ts';

const img = (id: string, imageId: string) => ({
  id,
  customData: { kind: 'image', imageId },
});
const edge = (
  id: string,
  from: string,
  to: string,
  relation: string,
  confidence?: string,
) => ({
  id,
  startBinding: { elementId: from },
  endBinding: { elementId: to },
  customData: {
    kind: 'edge',
    relation,
    direction: 'forward',
    properties: {},
    confidence,
  },
});
const els = [
  img('ea', 'A'),
  img('eb', 'B'),
  {
    id: 'r',
    customData: { kind: 'region', imageId: 'A', label: 'roof', properties: {} },
  },
  edge('x', 'r', 'eb', 'same place', 'likely'),
];
const name = (id: string) => `${id.toLowerCase()}.png`;

describe('describeSelection', () => {
  test('a picture says its connections', () => {
    expect(describeSelection(['ea'], els, name)).toBe(
      'a.png selected. 1 connection: same place.',
    );
  });
  test('a connection says its ends and how sure', () => {
    expect(describeSelection(['x'], els, name)).toBe(
      'Connection same place, from a.png to b.png, likely selected.',
    );
  });
  test('a region, several, and nothing', () => {
    expect(describeSelection(['r'], els, name)).toBe(
      'Region roof on a.png selected.',
    );
    expect(describeSelection(['ea', 'eb'], els, name)).toBe('2 selected.');
    expect(describeSelection([], els, name)).toBe('Nothing selected.');
  });
});
