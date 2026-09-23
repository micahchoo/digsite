import { describe, expect, test } from 'bun:test';
import { type Versioned, mergeByVersion } from '../src/sheet/merge.ts';

describe('mergeByVersion', () => {
  test('higher version wins', () => {
    const stored: Versioned[] = [{ id: 'a', version: 1, versionNonce: 5 }];
    const incoming: Versioned[] = [{ id: 'a', version: 2, versionNonce: 1 }];
    expect(mergeByVersion(stored, incoming)).toEqual([
      { id: 'a', version: 2, versionNonce: 1 },
    ]);
  });

  test('tie breaks to the lower versionNonce', () => {
    const stored: Versioned[] = [{ id: 'a', version: 1, versionNonce: 5 }];
    const lowerIncoming: Versioned[] = [
      { id: 'a', version: 1, versionNonce: 3 },
    ];
    expect(mergeByVersion(stored, lowerIncoming)).toEqual([
      { id: 'a', version: 1, versionNonce: 3 },
    ]);

    const higherIncoming: Versioned[] = [
      { id: 'a', version: 1, versionNonce: 10 },
    ];
    expect(mergeByVersion(stored, higherIncoming)).toEqual([
      { id: 'a', version: 1, versionNonce: 5 },
    ]);
  });

  test('an id present on only one side is kept', () => {
    const stored: Versioned[] = [{ id: 'a', version: 1, versionNonce: 1 }];
    const incoming: Versioned[] = [{ id: 'b', version: 1, versionNonce: 1 }];
    expect(mergeByVersion(stored, incoming)).toEqual([
      { id: 'a', version: 1, versionNonce: 1 },
      { id: 'b', version: 1, versionNonce: 1 },
    ]);
  });

  test('unindexed elements keep their stored order; new ones follow', () => {
    // Native-canvas scenes carry no index. An id sort put every claim (a
    // random uuid) before its image and reloads drew claims underneath.
    const stored: Versioned[] = [
      { id: 'img-c', version: 1, versionNonce: 1 },
      { id: 'img-a', version: 1, versionNonce: 1 },
      { id: '0e1f-edge', version: 1, versionNonce: 1 },
    ];
    const incoming: Versioned[] = [
      { id: 'b-new', version: 1, versionNonce: 1 },
      { id: 'img-a', version: 2, versionNonce: 1 },
    ];
    expect(mergeByVersion(stored, incoming).map((e) => e.id)).toEqual([
      'img-c',
      'img-a',
      '0e1f-edge',
      'b-new',
    ]);
  });
});

describe('mergeByVersion order', () => {
  test('sorts by fractional index, unindexed last in stored order', () => {
    const el = (id: string, index?: string) => ({
      id,
      version: 1,
      versionNonce: 1,
      ...(index === undefined ? {} : { index }),
    });
    const out = mergeByVersion(
      [el('text', 'b0O'), el('arrow', 'b0S'), el('fresh'), el('a')],
      [el('rect', 'ah')],
    );
    expect(out.map((e) => e.id)).toEqual([
      'rect',
      'text',
      'arrow',
      'fresh',
      'a',
    ]);
  });
});
