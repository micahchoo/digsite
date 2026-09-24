// Settings on this device (lib/preferences.ts): what is stored is checked
// field by field, and <html> carries the theme and motion.
import { describe, expect, test } from 'bun:test';
import { DEFAULTS, apply, parsePreferences } from '../src/lib/preferences.ts';
import { wheelGesture } from '../src/sheet/canvas/native/camera.ts';

describe('parsePreferences', () => {
  test('keeps each known choice and drops anything else', () => {
    expect(parsePreferences(null)).toEqual(DEFAULTS);
    expect(parsePreferences('not json')).toEqual(DEFAULTS);
    expect(
      parsePreferences(
        JSON.stringify({ theme: 'dark', motion: 'sideways', wheel: 'scroll' }),
      ),
    ).toEqual({ theme: 'dark', motion: 'system', wheel: 'scroll' });
  });
});

describe('apply', () => {
  test('system removes the attribute; a choice sets it', () => {
    const attrs = new Map<string, string>();
    const root = {
      setAttribute: (k: string, v: string) => attrs.set(k, v),
      removeAttribute: (k: string) => attrs.delete(k),
    } as unknown as HTMLElement;
    apply({ theme: 'dark', motion: 'reduce', wheel: 'zoom' }, root);
    expect(Object.fromEntries(attrs)).toEqual({
      'data-theme': 'dark',
      'data-motion': 'reduce',
    });
    apply(DEFAULTS, root);
    expect(attrs.size).toBe(0);
  });
});

describe('the wheel setting', () => {
  test('scroll makes a plain wheel scroll and leaves Ctrl+wheel zooming', () => {
    expect(wheelGesture({ deltaX: 0, deltaY: 100 }, 600, 'scroll')).toEqual({
      kind: 'scroll',
      dx: 0,
      dy: 100,
    });
    expect(
      wheelGesture({ deltaX: 0, deltaY: 100, ctrlKey: true }, 600, 'scroll')
        .kind,
    ).toBe('zoom');
  });
});
