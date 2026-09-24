// The top bar's `⋯` menu: the settings a person changes most, one click
// away, and the way to all of them (pages/Settings.tsx). Pure: it is handed
// the preferences and what each item does, and returns the sections
// board/ContextMenu.tsx draws.
import type { MenuSection } from '../board/ContextMenu.tsx';
import type { Preferences } from '../lib/preferences.ts';

export interface SettingsMenuActions {
  set: (change: Partial<Preferences>) => void;
  openSettings: () => void;
  signOut: () => void;
}

export function settingsMenu(
  p: Preferences,
  act: SettingsMenuActions,
): MenuSection[] {
  const theme = (value: Preferences['theme'], label: string) => ({
    label,
    checked: p.theme === value,
    testId: `menu-theme-${value}`,
    onSelect: () => act.set({ theme: value }),
  });
  const wheel = (value: Preferences['wheel'], label: string) => ({
    label,
    checked: p.wheel === value,
    testId: `menu-wheel-${value}`,
    onSelect: () => act.set({ wheel: value }),
  });
  return [
    [
      theme('system', 'Theme follows the system'),
      theme('light', 'Light theme'),
      theme('dark', 'Dark theme'),
    ],
    [
      wheel('zoom', 'Wheel zooms a sheet'),
      wheel('scroll', 'Wheel scrolls a sheet'),
    ],
    [
      {
        label: 'All settings…',
        testId: 'menu-settings',
        onSelect: act.openSettings,
      },
      { label: 'Sign out', testId: 'menu-sign-out', onSelect: act.signOut },
    ],
  ];
}
