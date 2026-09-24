// A web's question and its place in the URL (board/web-question.ts).
import { describe, expect, test } from 'bun:test';
import {
  MAX_ROOTS,
  readWebQuestion,
  webQuestion,
  webSearch,
  webTitle,
} from '../src/board/web-question.ts';

describe('webQuestion', () => {
  test('a few pictures look two steps out; many look one', () => {
    expect(webQuestion(['a']).hops).toBe(2);
    expect(webQuestion(['a', 'b', 'c', 'd']).hops).toBe(1);
    expect(webQuestion(['a', 'a', 'b']).roots).toEqual(['a', 'b']);
    const many = Array.from({ length: 50 }, (_, i) => `p${i}`);
    expect(webQuestion(many).roots).toHaveLength(MAX_ROOTS);
  });

  test('goes into the URL and comes back the same', () => {
    const q = webQuestion(['a', 'b'], { hops: 3, relation: ' same place ' });
    const search = webSearch(q);
    expect(search).toBe('?view=web&roots=a%2Cb&hops=3&relation=same+place');
    expect(readWebQuestion(new URLSearchParams(search))).toEqual(q);
  });

  test('the whole web has no start pictures; the map is no question', () => {
    expect(readWebQuestion(new URLSearchParams('view=web'))).toEqual({
      roots: [],
      hops: 2,
      relation: null,
    });
    expect(readWebQuestion(new URLSearchParams('image=x'))).toBeNull();
    expect(
      readWebQuestion(new URLSearchParams('view=web&roots=a&hops=9'))?.hops,
    ).toBe(2);
  });

  test('says what it asks', () => {
    const names = new Map([
      ['a', 'north.jpg'],
      ['b', 'south.jpg'],
    ]);
    const name = (id: string) => names.get(id);
    expect(webTitle(webQuestion([]), name)).toBe('The whole web of this board');
    expect(webTitle(webQuestion([], { relation: 'copy of' }), name)).toBe(
      'Every picture “copy of” joins',
    );
    expect(webTitle(webQuestion(['a', 'b']), name)).toBe(
      'The web around north.jpg and south.jpg',
    );
    expect(webTitle(webQuestion(['a', 'b', 'c']), name)).toBe(
      'The web around north.jpg, south.jpg and 1 more',
    );
  });
});
