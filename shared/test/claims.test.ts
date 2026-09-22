import { describe, expect, test } from 'bun:test';
import { claimId } from '../src/sheet/claims.ts';

describe('claimId', () => {
  test('sheetId:sourceId', () => {
    expect(claimId('sheet-1', 'el-9')).toBe('sheet-1:el-9');
  });
});
