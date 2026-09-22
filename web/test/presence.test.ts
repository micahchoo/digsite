// Pure tests, no DOM, no socket — see ../src/sheet/presence.ts.
import { describe, expect, test } from 'bun:test';
import {
  canSendPointer,
  colorForUser,
  peerCursors,
} from '../src/sheet/presence.ts';

describe('canSendPointer', () => {
  test('allows the very first send unconditionally', () => {
    expect(canSendPointer(1_000, null)).toBe(true);
  });

  test('throttles to at most 20/s — a 50ms minimum interval', () => {
    expect(canSendPointer(1_049, 1_000)).toBe(false);
    expect(canSendPointer(1_050, 1_000)).toBe(true);
  });

  test('a custom rate changes the interval', () => {
    expect(canSendPointer(1_099, 1_000, 10)).toBe(false); // 10/s -> 100ms
    expect(canSendPointer(1_100, 1_000, 10)).toBe(true);
  });
});

describe('colorForUser', () => {
  test('is deterministic — the same id always gets the same colour', () => {
    expect(colorForUser('u-123')).toBe(colorForUser('u-123'));
  });

  test('differs across ids — not a constant colour', () => {
    expect(colorForUser('u-1')).not.toBe(colorForUser('u-2'));
  });
});

describe('peerCursors', () => {
  test('carries position and colour, with no rects when nothing is selected', () => {
    const cursors = peerCursors(
      [{ x: 10, y: 20, selectedIds: [], user: 'u1', name: 'Ann' }],
      [],
    );
    expect(cursors).toEqual([
      {
        user: 'u1',
        name: 'Ann',
        x: 10,
        y: 20,
        color: colorForUser('u1'),
        rects: [],
      },
    ]);
  });

  test('includes the CURRENT rect of every selected element that still exists', () => {
    const elements = [
      { id: 'e1', x: 0, y: 0, width: 10, height: 10 },
      { id: 'e2', x: 100, y: 100, width: 20, height: 20, isDeleted: true },
    ];
    const cursors = peerCursors(
      [
        {
          x: 0,
          y: 0,
          selectedIds: ['e1', 'e2', 'missing'],
          user: 'u1',
          name: 'Ann',
        },
      ],
      elements,
    );
    expect(cursors[0]?.rects).toEqual([{ x: 0, y: 0, width: 10, height: 10 }]);
  });

  test('one entry per peer, independent of each other', () => {
    const cursors = peerCursors(
      [
        { x: 0, y: 0, selectedIds: [], user: 'u1', name: 'Ann' },
        { x: 5, y: 5, selectedIds: [], user: 'u2', name: 'Bo' },
      ],
      [],
    );
    expect(cursors.map((c) => c.user)).toEqual(['u1', 'u2']);
  });
});
