import { describe, expect, test } from 'bun:test';
import {
  agreementOf,
  buildVocabulary,
  canonicalOf,
  duplicateOf,
  normalizeTerm,
  pairKey,
  suggestTerms,
  termsMeaning,
  withAlias,
} from '../src/sheet/sense.ts';

describe('terms', () => {
  test('spellings of one term normalise together', () => {
    expect(normalizeTerm(' Same_Place ')).toBe('same place');
    expect(normalizeTerm('same-place')).toBe('same place');
    expect(normalizeTerm('same   place')).toBe('same place');
  });

  test('an alias resolves in one lookup, and a find matches every spelling', () => {
    const map = { 'same location': 'same place', 'same spot': 'same place' };
    expect(canonicalOf('same location', map)).toBe('same place');
    expect(canonicalOf('shares palette', map)).toBe('shares palette');
    expect(termsMeaning('same spot', map).sort()).toEqual([
      'same location',
      'same place',
      'same spot',
    ]);
  });

  test('withAlias keeps the map flat and refuses a self-alias', () => {
    const one = withAlias({}, 'same location', 'same place');
    expect(one).toEqual({ 'same location': 'same place' });
    // "same place" now means "identical place": its alias follows it.
    const two = withAlias(one ?? {}, 'same place', 'identical place');
    expect(two).toEqual({
      'same location': 'identical place',
      'same place': 'identical place',
    });
    // Aliasing onto an alias lands on its canonical.
    const three = withAlias(two ?? {}, 'same spot', 'same location');
    expect(three?.['same spot']).toBe('identical place');
    expect(withAlias(two ?? {}, 'identical place', 'same place')).toBeNull();
  });
});

describe('vocabulary', () => {
  const map = { 'same location': 'same place' };
  const vocabulary = buildVocabulary(
    [
      ['same place', 3],
      ['same location', 2],
      ['shares palette', 4],
      ['', 9],
    ],
    map,
  );

  test('counts fold onto the canonical term, most-used first, blanks ignored', () => {
    expect(vocabulary).toEqual([
      { term: 'same place', count: 5, aliases: ['same location'] },
      { term: 'shares palette', count: 4, aliases: [] },
    ]);
  });

  test('suggestions match through aliases and prefer a prefix', () => {
    expect(suggestTerms('loc', vocabulary).map((t) => t.term)).toEqual([
      'same place',
    ]);
    expect(suggestTerms('sha', vocabulary).map((t) => t.term)).toEqual([
      'shares palette',
    ]);
    expect(suggestTerms('', vocabulary, 1).map((t) => t.term)).toEqual([
      'same place',
    ]);
  });

  test('a term spelled another way is caught as a duplicate', () => {
    expect(duplicateOf('Same_Place', vocabulary)).toBe('same place');
    expect(duplicateOf('same-location', vocabulary)).toBe('same place');
    expect(duplicateOf('same place', vocabulary)).toBeNull();
    expect(duplicateOf('derived from', vocabulary)).toBeNull();
  });
});

describe('agreement', () => {
  const edge = (
    source: string,
    target: string,
    relation: string,
    direction: 'none' | 'forward' | 'reverse' | 'both' = 'forward',
  ) => ({
    source: { imageId: source },
    target: { imageId: target },
    relation,
    direction,
  });
  const map = { 'same location': 'same place' };

  test('a pair is unordered', () => {
    expect(pairKey('b', 'a')).toBe(pairKey('a', 'b'));
  });

  test('the same relation, however it was spelled or drawn, agrees', () => {
    expect(
      agreementOf(
        edge('a', 'b', 'same place'),
        edge('a', 'b', 'same location'),
        map,
      ),
    ).toBe('agree');
    // b -> a reverse is a -> b forward.
    expect(
      agreementOf(
        edge('a', 'b', 'derived from'),
        edge('b', 'a', 'derived from', 'reverse'),
        map,
      ),
    ).toBe('agree');
  });

  test('another relation, or the opposite direction, disagrees', () => {
    expect(
      agreementOf(
        edge('a', 'b', 'same place'),
        edge('a', 'b', 'different place'),
        map,
      ),
    ).toBe('disagree');
    expect(
      agreementOf(
        edge('a', 'b', 'derived from'),
        edge('b', 'a', 'derived from'),
        map,
      ),
    ).toBe('disagree');
  });

  test('an unnamed edge says nothing yet', () => {
    expect(
      agreementOf(edge('a', 'b', ''), edge('a', 'b', 'same place'), map),
    ).toBe('unknown');
  });
});
