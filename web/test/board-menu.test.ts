// The board's context menu (board/board-menu.ts): what each item acts on,
// and when one is refused. Pure — no DOM, no deck.gl.
import { describe, expect, test } from 'bun:test';
import type { MenuItem } from '../src/board/ContextMenu.tsx';
import {
  type BoardMenuActions,
  type BoardMenuState,
  DOWNLOAD_MAX,
  boardMenu,
} from '../src/board/board-menu.ts';

function recorder() {
  const calls: string[] = [];
  const note =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push(
        `${name} ${args.map((a) => JSON.stringify(a)).join(' ')}`.trim(),
      );
    };
  const act = new Proxy({} as BoardMenuActions, {
    get: (_t, name: string) => note(name),
  });
  return { calls, act };
}

const state = (over: Partial<BoardMenuState> = {}): BoardMenuState => ({
  selectedIds: [],
  find: null,
  canUndo: false,
  canRedo: false,
  ...over,
});

const item = (sections: MenuItem[][], label: string) => {
  const found = sections.flat().find((i) => i.label.startsWith(label));
  if (!found) throw new Error(`no item ${label}`);
  return found;
};

describe('a picture in the selection stands for all of it', () => {
  test('its sheet and copy items act on the whole selection', () => {
    const { calls, act } = recorder();
    const menu = boardMenu(
      { imageId: 'b', section: null },
      state({ selectedIds: ['a', 'b', 'c'] }),
      act,
    );
    item(menu, 'Start a sheet').onSelect();
    item(menu, 'Copy 3 pictures').onSelect();
    expect(calls).toEqual(['startSheet ["a","b","c"]', 'copyTo ["a","b","c"]']);
  });

  test('a picture outside the selection stands for itself alone', () => {
    const { calls, act } = recorder();
    const menu = boardMenu(
      { imageId: 'z', section: null },
      state({ selectedIds: ['a', 'b'] }),
      act,
    );
    item(menu, 'Add to sheet').onSelect();
    item(menu, 'Download').onSelect();
    expect(calls).toEqual(['addToSheet ["z"]', 'download ["z"]']);
  });
});

describe('the map', () => {
  test('a download past the server cap is offered, disabled, with the reason', () => {
    const ids = Array.from({ length: DOWNLOAD_MAX + 1 }, (_, i) => `i${i}`);
    const menu = boardMenu(null, state({ selectedIds: ids }), recorder().act);
    const download = item(menu, 'Download');
    expect(download.disabled).toBe(true);
    expect(download.disabledReason).toContain(`${DOWNLOAD_MAX}`);
  });

  test('with nothing found it offers Find; with a find, its matches', () => {
    const idle = boardMenu(null, state(), recorder().act);
    expect(item(idle, 'Find and filter').disabled).toBeFalsy();
    const found = boardMenu(
      null,
      state({ find: { count: 900, shown: 150 } }),
      recorder().act,
    );
    expect(item(found, 'Select all matches').label).toBe(
      'Select all matches (150)',
    );
    const none = boardMenu(
      null,
      state({ find: { count: 0, shown: 0 } }),
      recorder().act,
    );
    expect(item(none, 'Select all matches').disabled).toBe(true);
  });

  test('selection items appear only with a selection', () => {
    const empty = boardMenu(null, state(), recorder().act).flat();
    expect(empty.some((i) => i.label === 'Clear selection')).toBe(false);
    expect(empty.some((i) => i.label === 'Zoom to the selection')).toBe(false);
  });

  test('a picture in a section offers that section', () => {
    const menu = boardMenu(
      { imageId: 'a', section: { label: '1906' } },
      state(),
      recorder().act,
    );
    expect(item(menu, 'Select this section').label).toBe(
      'Select this section ("1906")',
    );
  });
});

describe('the map', () => {
  test('offers a report on the whole board', () => {
    const { calls, act } = recorder();
    item(boardMenu(null, state(), act), 'Report on this board').onSelect();
    expect(calls).toEqual(['report']);
  });
});

describe('find', () => {
  test('its matches open as a web', () => {
    const { calls, act } = recorder();
    item(
      boardMenu(null, state({ find: { count: 3, shown: 3 } }), act),
      'Open the matches as a web',
    ).onSelect();
    expect(calls).toEqual(['openMatchesWeb']);
  });
});
