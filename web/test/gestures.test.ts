// Pure: what a pointer press means per tool, and the drag-to-rect helper —
// no DOM, no Excalidraw — see ../src/sheet/gestures.ts.
import { describe, expect, test } from 'bun:test';
import { pointerIntent, rectFromDrag } from '../src/sheet/gestures.ts';

describe('pointerIntent', () => {
  test('select and pan are always native, whatever is under the press', () => {
    for (const tool of ['select', 'pan'] as const) {
      for (const target of ['image', 'region', 'edge', 'empty'] as const) {
        expect(pointerIntent({ tool, target, pendingSource: false })).toBe(
          'native',
        );
      }
    }
  });

  test('region only starts a draw when the press lands on an image', () => {
    expect(
      pointerIntent({ tool: 'region', target: 'image', pendingSource: false }),
    ).toBe('draw-region');
    for (const target of ['region', 'edge', 'empty'] as const) {
      expect(
        pointerIntent({ tool: 'region', target, pendingSource: false }),
      ).toBe('native');
    }
  });

  test('edge picks a source on an image or a region, never on empty canvas or an edge', () => {
    expect(
      pointerIntent({ tool: 'edge', target: 'image', pendingSource: false }),
    ).toBe('edge-source');
    expect(
      pointerIntent({ tool: 'edge', target: 'region', pendingSource: false }),
    ).toBe('edge-source');
    expect(
      pointerIntent({ tool: 'edge', target: 'empty', pendingSource: false }),
    ).toBe('native');
    expect(
      pointerIntent({ tool: 'edge', target: 'edge', pendingSource: false }),
    ).toBe('native');
  });

  test('a second press with a source pending completes the edge instead of restarting it', () => {
    expect(
      pointerIntent({ tool: 'edge', target: 'image', pendingSource: true }),
    ).toBe('edge-target');
    expect(
      pointerIntent({ tool: 'edge', target: 'region', pendingSource: true }),
    ).toBe('edge-target');
  });
});

describe('rectFromDrag', () => {
  test('normalises whichever corner the drag started on', () => {
    expect(rectFromDrag({ x: 10, y: 10 }, { x: 50, y: 40 })).toEqual({
      x: 10,
      y: 10,
      width: 40,
      height: 30,
    });
    expect(rectFromDrag({ x: 50, y: 40 }, { x: 10, y: 10 })).toEqual({
      x: 10,
      y: 10,
      width: 40,
      height: 30,
    });
  });

  test('a zero-distance drag is a zero-size rect at the point', () => {
    expect(rectFromDrag({ x: 5, y: 5 }, { x: 5, y: 5 })).toEqual({
      x: 5,
      y: 5,
      width: 0,
      height: 0,
    });
  });
});
