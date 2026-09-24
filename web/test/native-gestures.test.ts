// The native adapter's pointer decisions (canvas/native/gestures.ts), ported
// in spirit from research/image-graph/tests/gestures.test.ts — narrowed to
// the two modes (`select`, `pan`) the native canvas itself ever sees a
// pointer event for; `region`/`edge` are DrawLayer.tsx's (shared by both
// adapters, unchanged).
import { describe, expect, test } from 'bun:test';
import {
  DRAG_THRESHOLD,
  type DragInput,
  type Mode,
  type PressInput,
  cursorFor,
  dragBecomes,
  movedEnough,
  pressIntent,
  selectionAfterClick,
  selectionAfterMarquee,
} from '../src/sheet/canvas/native/gestures.ts';

const press = (over: Partial<PressInput> = {}): PressInput => ({
  mode: 'select',
  forcePan: false,
  button: 0,
  onGrip: false,
  ...over,
});
const drag = (over: Partial<DragInput> = {}): DragInput => ({
  forcePan: false,
  over: 'image',
  mode: 'select',
  ...over,
});
const MODES: Mode[] = ['select', 'pan', 'read'];

describe('movedEnough', () => {
  test('holds a press still inside the slack and releases it at the threshold', () => {
    const from = { x: 100, y: 100 };
    expect(movedEnough(from, { x: 100, y: 100 })).toBe(false);
    expect(movedEnough(from, { x: 100 + DRAG_THRESHOLD - 0.001, y: 100 })).toBe(
      false,
    );
    expect(movedEnough(from, { x: 100 + DRAG_THRESHOLD, y: 100 })).toBe(true);
  });

  test('measures distance, not either axis alone', () => {
    const from = { x: 0, y: 0 };
    expect(movedEnough(from, { x: 5, y: 0 })).toBe(false);
    expect(movedEnough(from, { x: 0, y: -5 })).toBe(false);
    expect(movedEnough(from, { x: 4, y: -4 })).toBe(false);
    expect(movedEnough(from, { x: 5, y: -5 })).toBe(true);
  });
});

describe('pressIntent', () => {
  test('takes a grip only in Select, with the primary button, nothing forcing a pan', () => {
    expect(pressIntent(press({ onGrip: true }))).toBe('handle');
    expect(pressIntent(press({ onGrip: true, mode: 'pan' }))).toBe('plain');
    expect(pressIntent(press({ onGrip: true, forcePan: true }))).toBe('plain');
    expect(pressIntent(press({ onGrip: true, button: 1 }))).toBe('plain');
    expect(pressIntent(press({ onGrip: false }))).toBe('plain');
  });
});

describe('selection modifiers', () => {
  test('Shift-click toggles without replacing the rest of the selection', () => {
    expect(selectionAfterClick(['a', 'b'], 'b', true)).toEqual(['a']);
    expect(selectionAfterClick(['a'], 'c', true)).toEqual(['a', 'c']);
    expect(selectionAfterClick(['a', 'b'], 'c', false)).toEqual(['c']);
  });

  test('Shift-marquee adds unique hits while a plain marquee replaces', () => {
    expect(selectionAfterMarquee(['a', 'b'], ['b', 'c'], true)).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(selectionAfterMarquee(['a', 'b'], ['b', 'c'], false)).toEqual([
      'b',
      'c',
    ]);
  });
});

describe('dragBecomes', () => {
  test('pans in the Pan tool regardless of what is under the press', () => {
    for (const over of ['image', 'region', 'edge', 'empty'] as const) {
      expect(dragBecomes(drag({ mode: 'pan', over }))).toBe('pan');
    }
  });

  test('pans from anywhere when space or the middle button forced it', () => {
    expect(
      dragBecomes(drag({ forcePan: true, over: 'image', mode: 'select' })),
    ).toBe('pan');
  });

  test('moves the group under a press on an image or a region, in Select', () => {
    expect(dragBecomes(drag({ over: 'image', mode: 'select' }))).toBe('move');
    expect(dragBecomes(drag({ over: 'region', mode: 'select' }))).toBe('move');
  });

  test('an unclaimed drag on a connection or empty canvas pans', () => {
    expect(dragBecomes(drag({ over: 'edge', mode: 'select' }))).toBe('pan');
    expect(dragBecomes(drag({ over: 'empty', mode: 'select' }))).toBe('pan');
  });

  test('always answers with something, for every combination', () => {
    for (const mode of MODES) {
      for (const over of ['image', 'region', 'edge', 'empty'] as const) {
        for (const forcePan of [true, false]) {
          expect(['pan', 'move']).toContain(
            dragBecomes({ mode, over, forcePan }),
          );
        }
      }
    }
  });
});

describe('read: a reader selects and pans, and edits nothing', () => {
  test('no grip, no move: every drag pans', () => {
    expect(
      pressIntent({ mode: 'read', forcePan: false, button: 0, onGrip: true }),
    ).toBe('plain');
    for (const over of ['image', 'region', 'edge', 'empty'] as const)
      expect(dragBecomes({ mode: 'read', over, forcePan: false })).toBe('pan');
  });

  test('the cursor points at what a click would select', () => {
    for (const target of ['image', 'region', 'edge'] as const)
      expect(
        cursorFor({
          mode: 'read',
          forcePan: false,
          dragging: null,
          target,
          grip: null,
        }),
      ).toBe('pointer');
  });
});

describe('cursorFor: the pointer says what a press would do', () => {
  const at = (over: Partial<Parameters<typeof cursorFor>[0]> = {}) =>
    cursorFor({
      mode: 'select',
      forcePan: false,
      dragging: null,
      target: 'empty',
      grip: null,
      ...over,
    });
  test('over a picture or region it moves; over a line it points', () => {
    expect(at({ target: 'image' })).toBe('move');
    expect(at({ target: 'region' })).toBe('move');
    expect(at({ target: 'edge' })).toBe('pointer');
    expect(at()).toBe('default');
  });
  test('a grip resizes along its own axis', () => {
    expect(at({ target: 'region', grip: 'e' })).toBe('ew-resize');
    expect(at({ grip: 'ne' })).toBe('nesw-resize');
  });
  test('panning grabs, and a held drag grabs harder', () => {
    expect(at({ mode: 'pan', target: 'image' })).toBe('grab');
    expect(at({ forcePan: true })).toBe('grab');
    expect(at({ dragging: 'pan' })).toBe('grabbing');
    expect(at({ dragging: 'marquee' })).toBe('crosshair');
  });
});
