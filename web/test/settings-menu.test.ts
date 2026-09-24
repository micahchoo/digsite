// The top bar's settings menu (shell/settings-menu.ts).
import { describe, expect, test } from 'bun:test';
import { DEFAULTS } from '../src/lib/preferences.ts';
import { settingsMenu } from '../src/shell/settings-menu.ts';

describe('settingsMenu', () => {
  test('checks the current choices and sets the one picked', () => {
    const calls: unknown[] = [];
    const menu = settingsMenu(
      { ...DEFAULTS, theme: 'dark' },
      {
        set: (c) => calls.push(c),
        openSettings: () => calls.push('settings'),
        signOut: () => calls.push('out'),
      },
    );
    const items = menu.flat();
    expect(items.filter((i) => i.checked).map((i) => i.testId)).toEqual([
      'menu-theme-dark',
      'menu-wheel-zoom',
    ]);
    items.find((i) => i.testId === 'menu-theme-light')?.onSelect();
    items.find((i) => i.testId === 'menu-wheel-scroll')?.onSelect();
    items.find((i) => i.testId === 'menu-settings')?.onSelect();
    expect(calls).toEqual([
      { theme: 'light' },
      { wheel: 'scroll' },
      'settings',
    ]);
  });
});
