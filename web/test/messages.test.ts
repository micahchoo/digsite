// Pure: the delete-confirmation sentences (docs/phases/3-groups.md section
// 4). No DOM, no fetch — see ../src/board/messages.ts.
import { describe, expect, test } from 'bun:test';
import {
  boardDeleteMessage,
  sheetDeleteMessage,
} from '../src/board/messages.ts';

describe('boardDeleteMessage', () => {
  test('pluralises each count independently', () => {
    expect(
      boardDeleteMessage('Field', {
        images: 1,
        sheets: 2,
        regions: 0,
        edges: 5,
      }),
    ).toBe(
      'Delete "Field"? This removes 1 image, 2 sheets, 0 regions and 5 edges.',
    );
  });

  test('a board with nothing on it still names the board', () => {
    expect(
      boardDeleteMessage('Empty', {
        images: 0,
        sheets: 0,
        regions: 0,
        edges: 0,
      }),
    ).toBe(
      'Delete "Empty"? This removes 0 images, 0 sheets, 0 regions and 0 edges.',
    );
  });
});

describe('sheetDeleteMessage', () => {
  test('zero foreign views gets its own sentence, not "0 other sheets"', () => {
    expect(sheetDeleteMessage('Faces', { foreignViews: 0 })).toBe(
      'Delete "Faces"? No other sheet shows a claim from it as foreign.',
    );
  });

  test('singular vs plural on the foreign-view count', () => {
    expect(sheetDeleteMessage('Faces', { foreignViews: 1 })).toBe(
      'Delete "Faces"? This removes its claims currently showing as foreign in 1 other sheet.',
    );
    expect(sheetDeleteMessage('Faces', { foreignViews: 3 })).toBe(
      'Delete "Faces"? This removes its claims currently showing as foreign in 3 other sheets.',
    );
  });
});
