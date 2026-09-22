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
  dragBecomes,
  movedEnough,
  pressIntent,
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
const MODES: Mode[] = ['select', 'pan'];

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

  test('draws the marquee over a connection or empty canvas, in Select', () => {
    expect(dragBecomes(drag({ over: 'edge', mode: 'select' }))).toBe('marquee');
    expect(dragBecomes(drag({ over: 'empty', mode: 'select' }))).toBe(
      'marquee',
    );
  });

  test('always answers with something, for every combination', () => {
    for (const mode of MODES) {
      for (const over of ['image', 'region', 'edge', 'empty'] as const) {
        for (const forcePan of [true, false]) {
          expect(['pan', 'move', 'marquee']).toContain(
            dragBecomes({ mode, over, forcePan }),
          );
        }
      }
    }
  });
});
