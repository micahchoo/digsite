// Pure tests, no DOM, no Excalidraw — see ../src/sheet/overlay/screen.ts.
import { describe, expect, test } from 'bun:test';
import type { Foreign } from '@digsite/shared';
import {
  type ElementLike,
  foreignCopyRect,
  foreignShapes,
  rectToScreen,
  sceneToScreen,
} from '../src/sheet/overlay/screen.ts';

describe('sceneToScreen', () => {
  test("matches Excalidraw's sceneCoordsToViewportCoords formula", () => {
    // screenX = (sceneX + scrollX) * zoom.value + offsetLeft — verified
    // against research/excalidraw/packages/common/src/utils.ts.
    const vp = { scrollX: 50, scrollY: -20, zoom: 2 };
    const offset = { left: 10, top: 5 };
    const p = sceneToScreen({ x: 100, y: 200 }, vp, offset);
    expect(p.x).toBe((100 + 50) * 2 + 10);
    expect(p.y).toBe((200 + -20) * 2 + 5);
  });

  test('offset {0,0} is the common case: screen = (scene + scroll) * zoom', () => {
    const vp = { scrollX: 0, scrollY: 0, zoom: 1.5 };
    const p = sceneToScreen({ x: 40, y: 40 }, vp, { left: 0, top: 0 });
    expect(p).toEqual({ x: 60, y: 60 });
  });
});

describe('rectToScreen', () => {
  test('scales width/height by zoom and offsets the top-left', () => {
    const vp = { scrollX: 0, scrollY: 0, zoom: 2 };
    const r = rectToScreen({ x: 10, y: 10, width: 30, height: 40 }, vp, {
      left: 0,
      top: 0,
    });
    expect(r).toEqual({ x: 20, y: 20, width: 60, height: 80 });
  });
});

function image(
  id: string,
  imageId: string,
  x: number,
  y: number,
  width = 256,
  height = 256,
): ElementLike {
  return { id, x, y, width, height, customData: { kind: 'image', imageId } };
}

describe('foreignShapes', () => {
  const rows: Foreign = {
    regions: [
      {
        id: 'other:r1',
        sheetId: 'other',
        sourceId: 'r1',
        imageId: 'img-1',
        fx: 0.25,
        fy: 0.25,
        fw: 0.5,
        fh: 0.5,
        label: 'find',
        properties: {},
        sheetName: 'Other sheet',
      },
    ],
    edges: [],
  };

  test('places a foreign region from the CURRENT image rect', () => {
    const elements = [image('e1', 'img-1', 0, 0, 200, 200)];
    const shapes = foreignShapes(rows, elements);
    expect(shapes).toHaveLength(1);
    const shape = shapes[0];
    if (shape?.kind !== 'region') throw new Error('expected a region shape');
    expect(shape.rect).toEqual({ x: 50, y: 50, width: 100, height: 100 });
    expect(shape.sheetName).toBe('Other sheet');
  });

  test('recomputes against a MOVED image rect, not a stale one', () => {
    const before = foreignShapes(rows, [image('e1', 'img-1', 0, 0, 200, 200)]);
    const after = foreignShapes(rows, [
      image('e1', 'img-1', 1000, 1000, 200, 200),
    ]);
    const beforeShape = before[0];
    const afterShape = after[0];
    if (beforeShape?.kind !== 'region' || afterShape?.kind !== 'region') {
      throw new Error('expected region shapes');
    }
    expect(afterShape.rect).toEqual({
      x: 1050,
      y: 1050,
      width: 100,
      height: 100,
    });
    expect(afterShape.rect).not.toEqual(beforeShape.rect);
  });

  test('omits a region whose image this sheet does not hold', () => {
    expect(foreignShapes(rows, [])).toEqual([]);
  });
});

describe('foreignCopyRect', () => {
  test('is the fraction applied to the image rect it is given — never a cached one', () => {
    const row = { fx: 0.1, fy: 0.2, fw: 0.3, fh: 0.4 };
    const original = { x: 0, y: 0, width: 200, height: 200 };
    const moved = { x: 500, y: 500, width: 200, height: 200 };

    const beforeMove = foreignCopyRect(row, original);
    const afterMove = foreignCopyRect(row, moved);

    expect(beforeMove).toEqual({ x: 20, y: 40, width: 60, height: 80 });
    // same fraction, moved image -> the copy follows the move, proving the
    // caller must supply the CURRENT rect rather than this function caching one.
    expect(afterMove).toEqual({ x: 520, y: 540, width: 60, height: 80 });
    expect(afterMove).not.toEqual(beforeMove);
  });
});
