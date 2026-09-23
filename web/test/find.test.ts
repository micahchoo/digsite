import { describe, expect, test } from 'bun:test';
import type { SortableKey } from '@digsite/shared';
import {
  type FindAsker,
  type FindQuestion,
  MEANING_PAGE,
  NO_QUESTION,
  askFind,
  findReducer,
  isAsked,
  parseFilter,
  questionKey,
  shapeFind,
} from '../src/board/find.ts';

const run = (...actions: Parameters<typeof findReducer>[1][]): FindQuestion =>
  actions.reduce(findReducer, NO_QUESTION);

const harbour = { id: 'img-1', name: 'harbour.png' };

describe('the find question', () => {
  test('typing leaves "more like this" and starts from the first page', () => {
    const q = run(
      { type: 'like', image: harbour },
      { type: 'more' },
      { type: 'text', text: 'boat' },
    );
    expect(q.like).toBeNull();
    expect(q.limit).toBe(MEANING_PAGE);
    expect(q.text).toBe('boat');
  });

  test('"more like this" empties the words', () => {
    const q = run(
      { type: 'text', text: 'boat' },
      { type: 'like', image: harbour },
    );
    expect(q.text).toBe('');
    expect(q.like).toEqual(harbour);
  });

  test('Show more asks for one more page', () => {
    const q = run(
      { type: 'mode', mode: 'meaning' },
      { type: 'more' },
      { type: 'more' },
    );
    expect(q.limit).toBe(3 * MEANING_PAGE);
  });

  test('a filter on a property replaces the one before it', () => {
    const q = run(
      { type: 'filter', clause: { key: 'year', op: 'gte', value: 1900 } },
      { type: 'filter', clause: { key: 'site', op: 'eq', value: 'A' } },
      { type: 'filter', clause: { key: 'year', op: 'lte', value: 1950 } },
    );
    expect(q.filters).toEqual([
      { key: 'site', op: 'eq', value: 'A' },
      { key: 'year', op: 'lte', value: 1950 },
    ]);
    expect(findReducer(q, { type: 'unfilter', key: 'site' }).filters).toEqual([
      { key: 'year', op: 'lte', value: 1950 },
    ]);
  });

  test('Clear clears everything the person set, the claim too, and keeps the mode', () => {
    const q = run(
      { type: 'mode', mode: 'meaning' },
      { type: 'text', text: 'boat' },
      { type: 'claim', claim: { kind: 'label', term: 'chimney' } },
      { type: 'filter', clause: { key: 'site', op: 'eq', value: 'A' } },
      { type: 'clear' },
    );
    expect(q).toEqual({ ...NO_QUESTION, mode: 'meaning' });
  });

  test('a search by meaning ignores filters and claims', () => {
    const q = run(
      { type: 'claim', claim: { kind: 'label', term: 'chimney' } },
      { type: 'mode', mode: 'meaning' },
    );
    expect(isAsked(q)).toBe(false);
    expect(
      isAsked(run({ type: 'claim', claim: { kind: 'label', term: 'x' } })),
    ).toBe(true);
  });

  test('Show more on a words find asks nothing new', () => {
    const words = run({ type: 'text', text: 'boat' });
    expect(questionKey(findReducer(words, { type: 'more' }))).toBe(
      questionKey(words),
    );
    const meaning = run(
      { type: 'mode', mode: 'meaning' },
      { type: 'text', text: 'boat' },
    );
    expect(questionKey(findReducer(meaning, { type: 'more' }))).not.toBe(
      questionKey(meaning),
    );
  });
});

describe('asking', () => {
  function client() {
    const calls: string[] = [];
    const c: FindAsker = {
      findBoard: async (_b, _s, q, filters, claims) => {
        calls.push(`find ${q} ${filters.length} ${JSON.stringify(claims)}`);
        return { ranks: [], imageIds: [], count: 0 };
      },
      searchMeaning: async (_b, _s, text, limit) => {
        calls.push(`search ${text} ${limit}`);
        return { matches: [] };
      },
      similarImages: async (_b, _s, id, limit) => {
        calls.push(`similar ${id} ${limit}`);
        return { matches: [] };
      },
    };
    return { c, calls };
  }

  test('each kind of question makes its one request', async () => {
    const { c, calls } = client();
    await askFind(
      c,
      'b',
      's',
      run(
        { type: 'text', text: ' boat ' },
        { type: 'claim', claim: { kind: 'relation', term: 'same place' } },
      ),
    );
    await askFind(
      c,
      'b',
      's',
      run({ type: 'mode', mode: 'meaning' }, { type: 'text', text: 'boat' }),
    );
    await askFind(c, 'b', 's', run({ type: 'like', image: harbour }));
    expect(calls).toEqual([
      'find boat 0 {"relation":"same place"}',
      `search boat ${MEANING_PAGE}`,
      `similar img-1 ${MEANING_PAGE}`,
    ]);
  });

  test('matches by meaning are shaped best first', () => {
    expect(
      shapeFind({
        matches: [
          { imageId: 'a', rank: 7, score: 0.3 },
          { imageId: 'b', rank: 2, score: 0.2 },
        ],
      }),
    ).toEqual({ ranks: [7, 2], imageIds: ['a', 'b'], count: 2, ranked: true });
  });
});

describe('a property filter from the panel', () => {
  const keys: SortableKey[] = [
    { key: 'name', label: 'Name' },
    { key: { property: 'year', type: 'number' }, label: 'year' },
    { key: { property: 'site', type: 'text' }, label: 'site' },
  ];

  test('a number property takes a number, and refuses anything else', () => {
    expect(parseFilter(keys, 'year', 'gte', '1900')).toEqual({
      key: 'year',
      op: 'gte',
      value: 1900,
    });
    expect(parseFilter(keys, 'year', 'gte', 'old')).toBeNull();
  });

  test('a text property takes the trimmed words; nothing chosen is nothing', () => {
    expect(parseFilter(keys, 'site', 'eq', ' A ')).toEqual({
      key: 'site',
      op: 'eq',
      value: 'A',
    });
    expect(parseFilter(keys, '', 'eq', 'A')).toBeNull();
    expect(parseFilter(keys, 'site', 'eq', '  ')).toBeNull();
  });
});
