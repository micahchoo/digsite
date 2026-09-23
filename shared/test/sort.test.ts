import { describe, expect, test } from 'bun:test';
import { type Sort, parseSortId, sortId } from '../src/board/sort.ts';

describe('sortId / parseSortId round-trip', () => {
  test('a column key (name)', () => {
    const s: Sort = { key: 'name', dir: 'asc' };
    expect(sortId(s)).toBe('name.asc');
    expect(parseSortId(sortId(s))).toEqual(s);
  });

  test('a column key (uploaded_at)', () => {
    const s: Sort = { key: 'uploaded_at', dir: 'desc' };
    expect(sortId(s)).toBe('uploaded_at.desc');
    expect(parseSortId(sortId(s))).toEqual(s);
  });

  test('a column key (meaning)', () => {
    const s: Sort = { key: 'meaning', dir: 'asc' };
    expect(sortId(s)).toBe('meaning.asc');
    expect(parseSortId(sortId(s))).toEqual(s);
  });

  test('a property key', () => {
    const s: Sort = { key: { property: 'year', type: 'number' }, dir: 'asc' };
    expect(sortId(s)).toBe('p.number.year.asc');
    expect(parseSortId(sortId(s))).toEqual(s);
  });
});

describe('parseSortId rejects', () => {
  test('an invalid direction', () => {
    expect(parseSortId('name.up')).toBeNull();
  });

  test('an empty property name', () => {
    expect(parseSortId('p.text..asc')).toBeNull();
  });

  test('garbage', () => {
    expect(parseSortId("'; DROP")).toBeNull();
  });

  test('empty string', () => {
    expect(parseSortId('')).toBeNull();
  });
});
