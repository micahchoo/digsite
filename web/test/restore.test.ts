// Every element from outside is brought to full shape once (restore.ts).
import { describe, expect, test } from 'bun:test';
import {
  restoreElement,
  restoreElements,
} from '../src/sheet/canvas/native/restore.ts';

describe('restoreElement', () => {
  test('fills what a wire element lacks, as a new element would have it', () => {
    const el = restoreElement({ id: 'a', type: 'image', x: 5 });
    expect(el).toMatchObject({
      id: 'a',
      x: 5,
      y: 0,
      groupIds: [],
      boundElements: null,
      startBinding: null,
      endBinding: null,
      points: [],
      isDeleted: false,
    });
  });

  test('keeps every structural field that is present, exactly', () => {
    const raw = {
      id: 'e',
      type: 'arrow',
      version: 7,
      versionNonce: 3,
      isDeleted: false,
      updated: 9,
      x: 1,
      y: 2,
      width: 3,
      height: 4,
      groupIds: ['g1'],
      boundElements: [{ id: 't', type: 'text' }],
      startBinding: { elementId: 'a', focus: 0.2 },
      endBinding: { elementId: 'b' },
      points: [
        [0, 0],
        [3, 4],
      ],
      startArrowhead: null,
      endArrowhead: 'arrow',
      customData: {
        kind: 'edge',
        made: { id: 'u', name: 'M', at: 'x', sig: 's' },
      },
    };
    expect(restoreElement(raw)).toEqual(raw as never);
  });

  test('an element with no id cannot be known and is dropped', () => {
    expect(
      restoreElements([{ type: 'image' }, null, 3, { id: 'ok' }]).map(
        (e) => e.id,
      ),
    ).toEqual(['ok']);
  });
});
