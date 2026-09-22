import { describe, expect, test } from 'bun:test';
import { ladderAddress, perPage, sizeFor } from '../src/board/ladder.ts';

describe('perPage', () => {
  test('4096 / 256 / 16 for 8 / 32 / 128', () => {
    expect(perPage(8)).toBe(4096);
    expect(perPage(32)).toBe(256);
    expect(perPage(128)).toBe(16);
  });
});

describe('ladderAddress', () => {
  test('slot 0 at S=8: first cell of page 0', () => {
    expect(ladderAddress(0, 8)).toEqual({ page: 0, x: 0, y: 0 });
  });

  test('slot 4095 at S=8: last cell of page 0', () => {
    expect(ladderAddress(4095, 8)).toEqual({ page: 0, x: 504, y: 504 });
  });

  test('slot 4096 at S=8: first cell of page 1', () => {
    expect(ladderAddress(4096, 8)).toEqual({ page: 1, x: 0, y: 0 });
  });
});

describe('sizeFor', () => {
  test('smallest ladder size at least cellPx, else 128', () => {
    expect(sizeFor(4)).toBe(8);
    expect(sizeFor(8)).toBe(8);
    expect(sizeFor(16)).toBe(32);
    expect(sizeFor(64)).toBe(128);
    expect(sizeFor(200)).toBe(128);
  });
});
