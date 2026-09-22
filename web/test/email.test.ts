// Pure: the invite form's client-side email check (docs/ux/audit.md #7) —
// no DOM, no fetch. See ../src/lib/email.ts.
import { describe, expect, test } from 'bun:test';
import { isValidEmail } from '../src/lib/email.ts';

describe('isValidEmail', () => {
  test('accepts an ordinary address', () => {
    expect(isValidEmail('owner@example.test')).toBe(true);
  });

  test('rejects no @', () => {
    expect(isValidEmail('owner.example.test')).toBe(false);
  });

  test('rejects no domain dot', () => {
    expect(isValidEmail('owner@example')).toBe(false);
  });

  test('rejects whitespace', () => {
    expect(isValidEmail('owner @example.test')).toBe(false);
  });

  test('rejects an empty string — the form treats blank as "no email" separately', () => {
    expect(isValidEmail('')).toBe(false);
  });
});
