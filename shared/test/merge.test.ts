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

  test('output order is stable by id regardless of input order', () => {
    const stored: Versioned[] = [
      { id: 'c', version: 1, versionNonce: 1 },
      { id: 'a', version: 1, versionNonce: 1 },
    ];
    const incoming: Versioned[] = [{ id: 'b', version: 1, versionNonce: 1 }];
    expect(mergeByVersion(stored, incoming).map((e) => e.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });
});
