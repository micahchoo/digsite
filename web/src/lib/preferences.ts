// How this person wants the app on this device (pages/Settings.tsx): the
// theme, motion, and what a mouse wheel does on a sheet. Kept in
// localStorage, because each is about a screen and a hand, not an account;
// a private window or blocked storage falls back to the defaults.
//
// The theme and motion are attributes on <html>, the one switch tokens.css
// and style.css already read (`data-theme`, `data-motion`). `apply` runs
// before the first render (main.tsx), so a reload never flashes the other
// theme.
import { useEffect, useState } from 'react';

export type Theme = 'system' | 'light' | 'dark';
export type Motion = 'system' | 'reduce';
/** A plain wheel on a sheet: zoom about the pointer (as on the board), or
 * scroll with Ctrl+wheel to zoom (what a trackpad hand may prefer). */
export type Wheel = 'zoom' | 'scroll';

export type Preferences = { theme: Theme; motion: Motion; wheel: Wheel };

export const DEFAULTS: Preferences = {
  theme: 'system',
  motion: 'system',
  wheel: 'zoom',
};

const KEY = 'digsite:preferences';
const CHOICES: { [K in keyof Preferences]: readonly Preferences[K][] } = {
  theme: ['system', 'light', 'dark'],
  motion: ['system', 'reduce'],
  wheel: ['zoom', 'scroll'],
};

/** What was stored, each field checked, the rest the defaults. */
export function parsePreferences(raw: string | null): Preferences {
  let stored: Record<string, unknown> = {};
  try {
    const v = raw ? JSON.parse(raw) : null;
    if (v && typeof v === 'object') stored = v as Record<string, unknown>;
  } catch {
    // unreadable: the defaults
  }
  const out = { ...DEFAULTS };
  for (const key of Object.keys(CHOICES) as (keyof Preferences)[]) {
    const v = stored[key];
    if ((CHOICES[key] as readonly unknown[]).includes(v))
      (out as Record<string, unknown>)[key] = v;
  }
  return out;
}

function read(): Preferences {
  try {
    return parsePreferences(localStorage.getItem(KEY));
  } catch {
    return { ...DEFAULTS };
  }
}

/** Sets <html>'s attributes; `system` removes them, so the media query
 * decides. */
export function apply(
  p: Preferences,
  root: HTMLElement = document.documentElement,
): void {
  if (p.theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', p.theme);
  if (p.motion === 'system') root.removeAttribute('data-motion');
  else root.setAttribute('data-motion', p.motion);
}

const listeners = new Set<(p: Preferences) => void>();
let current: Preferences | null = null;

export function preferences(): Preferences {
  current ??= read();
  return current;
}

export function setPreferences(change: Partial<Preferences>): void {
  current = { ...preferences(), ...change };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // Not kept past this page; still applied now.
  }
  apply(current);
  for (const listen of listeners) listen(current);
}

export function usePreferences(): Preferences {
  const [p, setP] = useState(preferences);
  useEffect(() => {
    listeners.add(setP);
    return () => {
      listeners.delete(setP);
    };
  }, []);
  return p;
}
