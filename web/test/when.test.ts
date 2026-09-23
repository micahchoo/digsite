import { describe, expect, test } from 'bun:test';
import { ago } from '../src/lib/when.ts';

const now = Date.parse('2026-09-23T12:00:00Z');
describe('ago', () => {
  test('says it the way a person would', () => {
    expect(ago('2026-09-23T11:59:40Z', now)).toBe('just now');
    expect(ago('2026-09-23T11:56:00Z', now)).toBe('4 min ago');
    expect(ago('2026-09-23T09:00:00Z', now)).toBe('3 h ago');
    expect(ago('2026-09-22T12:00:00Z', now)).toBe('yesterday');
    expect(ago('2026-09-20T12:00:00Z', now)).toBe('3 days ago');
    expect(ago('2026-01-02T12:00:00Z', now)).toContain('2026');
  });
  test('a malformed time says nothing', () => {
    expect(ago('not a time', now)).toBe('');
  });
});
