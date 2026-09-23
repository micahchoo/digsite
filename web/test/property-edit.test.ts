import { describe, expect, test } from 'bun:test';
import {
  convert,
  draftOf,
  isDate,
  parseDraft,
  typeOfValue,
} from '../src/board/property-edit.ts';

describe('the five property types, in the shapes the server sorts', () => {
  test('a value knows its type; a date is a calendar day written YYYY-MM-DD', () => {
    expect(typeOfValue('harbour')).toBe('text');
    expect(typeOfValue(3)).toBe('number');
    expect(typeOfValue(false)).toBe('boolean');
    expect(typeOfValue('2026-09-23')).toBe('date');
    expect(typeOfValue(['a', 'b'])).toBe('list');
    expect(isDate('2026-02-30')).toBe(false);
    expect(typeOfValue('23/09/2026')).toBe('text');
  });

  test('a negative number can be typed: the draft is read once, on commit', () => {
    expect(parseDraft('-', 'number')).toEqual({ error: 'Not a number' });
    expect(parseDraft('-3', 'number')).toEqual({ value: -3 });
    expect(parseDraft('12.5', 'number')).toEqual({ value: 12.5 });
    expect(parseDraft('', 'number')).toEqual({ error: 'Not a number' });
  });

  test('a list stays a list when edited', () => {
    expect(draftOf(['north', 'wall'])).toBe('north, wall');
    expect(parseDraft('north, wall , ,gate', 'list')).toEqual({
      value: ['north', 'wall', 'gate'],
    });
  });

  test('a date must be one', () => {
    expect(parseDraft(' 2026-09-23 ', 'date')).toEqual({ value: '2026-09-23' });
    expect(parseDraft('yesterday', 'date')).toEqual({
      error: 'A date, as 2026-09-23',
    });
  });

  test('text keeps its spaces', () => {
    expect(parseDraft('  two  spaces ', 'text')).toEqual({
      value: '  two  spaces ',
    });
  });
});

describe('changing a type', () => {
  test('anything becomes a list of one, and a list becomes its items joined', () => {
    expect(convert('wall', 'list')).toEqual({ value: ['wall'] });
    expect(convert('', 'list')).toEqual({ value: [] });
    expect(convert(['a', 'b'], 'text')).toEqual({ value: 'a, b' });
  });

  test('text that is not a number is refused, not turned into 0', () => {
    expect(convert('harbour', 'number')).toEqual({ error: 'Not a number' });
    expect(convert('42', 'number')).toEqual({ value: 42 });
  });

  test('yes and no read as a person writes them', () => {
    expect(convert('yes', 'boolean')).toEqual({ value: true });
    expect(convert('', 'boolean')).toEqual({ value: false });
    expect(convert('maybe', 'boolean')).toEqual({ error: 'Yes or no' });
  });
});
