// Pure tests, no DOM or canvas — see ../src/sheet/overlay/screen.ts.
import { describe, expect, test } from 'bun:test';
import type { Foreign } from '@digsite/shared';
import {
  connectionOpacity,
  endImages,
  focusOf,
  inFocus,
  relationOpacity,
} from '../src/sheet/connection-emphasis.ts';
import {
  type ElementLike,
  foreignCopyRect,
  foreignShapes,
  placeConnectionLabels,
  placeRegionLabels,
  rectToScreen,
  sceneToScreen,
  screenToScene,
} from '../src/sheet/overlay/screen.ts';

describe('sceneToScreen', () => {
  test('matches the sheet scene-to-viewport coordinate formula', () => {
    // screenX = (sceneX + scrollX) * zoom.value + offsetLeft — verified
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

describe('relation emphasis', () => {
  test('dims only nonmatching connections without changing their identity', () => {
    expect(relationOpacity('resembles', 'resembles')).toBe(1);
    expect(relationOpacity('resembles', null)).toBe(1);
    expect(relationOpacity('overlaps', 'resembles')).toBe(0.12);
  });
});

describe('focus emphasis', () => {
  const img = (id: string, imageId: string) => ({
    id,
    customData: { kind: 'image', imageId },
  });
  const reg = (id: string, imageId: string) => ({
    id,
    customData: { kind: 'region', imageId, label: 'x', properties: {} },
  });
  const elements = [
    img('ea', 'A'),
    img('eb', 'B'),
    img('ec', 'C'),
    reg('ra', 'A'),
  ];
  const byId = new Map(elements.map((el) => [el.id, el] as const));
  const bc = {
    id: 'bc',
    startBinding: { elementId: 'eb' },
    endBinding: { elementId: 'ec' },
  };
  const ab = {
    id: 'ab',
    startBinding: { elementId: 'ra' },
    endBinding: { elementId: 'eb' },
  };

  test('with nothing selected every connection is in focus', () => {
    expect(focusOf(elements, [])).toBeNull();
    expect(inFocus(null, 'bc', endImages(bc, byId))).toBe(true);
  });

  test('a selected region puts the connections of its picture in focus, and only those', () => {
    const focus = focusOf(elements, ['ra']);
    expect(inFocus(focus, 'ab', endImages(ab, byId))).toBe(true);
    expect(inFocus(focus, 'bc', endImages(bc, byId))).toBe(false);
  });

  test('a selected connection is in focus itself', () => {
    expect(inFocus(focusOf(elements, ['bc']), 'bc', [null, null])).toBe(true);
  });

  test('the lower of the two answers wins', () => {
    expect(connectionOpacity('resembles', null, true)).toBe(1);
    expect(connectionOpacity('resembles', null, false)).toBe(0.3);
    expect(connectionOpacity('overlaps', 'resembles', false)).toBe(0.12);
  });
});

describe('screenToScene', () => {
  test('is the exact inverse of sceneToScreen — DrawLayer.tsx round-trips a pointer through both', () => {
    const vp = { scrollX: 50, scrollY: -20, zoom: 2 };
    const offset = { left: 10, top: 5 };
    const scene = { x: 100, y: 200 };
    const screen = sceneToScreen(scene, vp, offset);
    expect(screenToScene(screen, vp, offset)).toEqual(scene);
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

describe('placeConnectionLabels', () => {
  test('moves labels clear of image boxes and other connection labels', () => {
    const line = [
      { x: 10, y: 150 },
      { x: 490, y: 150 },
    ] as const;
    const labels = placeConnectionLabels(
      [
        { id: 'a', label: 'resembles', line, priority: 10 },
        { id: 'b', label: 'resembles', line, priority: 0 },
      ],
      [{ x: 220, y: 100, width: 60, height: 100 }],
      500,
      300,
      (label) => label.length * 7,
    );
    expect(labels).toHaveLength(2);
    const first = labels[0];
    const second = labels[1];
    if (!first || !second) throw new Error('expected both labels to be placed');
    const intersects = (
      a: { x: number; y: number; width: number; height: number },
      b: { x: number; y: number; width: number; height: number },
    ) =>
      a.x < b.x + b.width &&
      a.x + a.width > b.x &&
      a.y < b.y + b.height &&
      a.y + a.height > b.y;
    expect(intersects(first, { x: 220, y: 100, width: 60, height: 100 })).toBe(
      false,
    );
    expect(intersects(second, { x: 220, y: 100, width: 60, height: 100 })).toBe(
      false,
    );
    expect(intersects(first, second)).toBe(false);
  });
});

describe('placeRegionLabels', () => {
  test('separates overlapping foreign claims from each other and an own-region label', () => {
    const region = { x: 180, y: 120, width: 150, height: 110 };
    const ownLabel = { x: 184, y: 123, width: 54, height: 14 };
    const labels = placeRegionLabels(
      [
        { id: 'foreign-a', label: 'find one', rect: region, priority: 0 },
        { id: 'foreign-b', label: 'find two', rect: region, priority: 0 },
        { id: 'foreign-c', label: 'find three', rect: region, priority: 100 },
      ],
      [ownLabel],
      600,
      400,
      (label) => label.length * 7,
    );
    expect(labels.map((label) => label.id)[0]).toBe('foreign-c');
    expect(labels).toHaveLength(3);
    for (let i = 0; i < labels.length; i += 1) {
      const label = labels[i];
      if (!label) continue;
      expect(intersects(label, ownLabel)).toBe(false);
      for (let j = i + 1; j < labels.length; j += 1) {
        const other = labels[j];
        if (other) expect(intersects(label, other)).toBe(false);
      }
    }
  });
});

function intersects(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

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

describe('foreignShapes: dangling from a vanished foreign region (docs/phases/2-sheet.md section 5)', () => {
  test('an edge end whose regionSourceId is not among the current foreign regions draws to the image and is marked dangling', () => {
    const rows: Foreign = {
      regions: [], // the region backing this edge's start end is gone from THIS poll
      edges: [
        {
          id: 'other:e1',
          sheetId: 'other',
          sourceId: 'e1',
          source: { imageId: 'img-1', regionSourceId: 'gone-region' },
          target: { imageId: 'img-2' },
          direction: 'forward',
          relation: 'r',
          properties: {},
          confidence: null,
          note: '',
          sheetName: 'Other sheet',
        },
      ],
    };
    const elements = [
      image('e1', 'img-1', 0, 0, 200, 200),
      image('e2', 'img-2', 500, 0, 200, 200),
    ];
    const shapes = foreignShapes(rows, elements);
    const edge = shapes.find((s) => s.kind === 'edge');
    if (!edge || edge.kind !== 'edge')
      throw new Error('expected an edge shape');
    expect(edge.danglingStart).toBe(true);
    expect(edge.danglingEnd).toBe(false);
    // drawn to the image, same as a plain image end: stopping at its border
    // (clipBetween), so the line never covers the picture it joins.
    expect(edge.line[0]).toEqual({ x: 200, y: 100 });
  });

  test('an edge end whose region IS among the current foreign regions is not dangling', () => {
    const rows: Foreign = {
      regions: [
        {
          id: 'other:r1',
          sheetId: 'other',
          sourceId: 'r1',
          imageId: 'img-1',
          fx: 0,
          fy: 0,
          fw: 0.5,
          fh: 0.5,
          label: '',
          properties: {},
          sheetName: 'Other sheet',
        },
      ],
      edges: [
        {
          id: 'other:e1',
          sheetId: 'other',
          sourceId: 'e1',
          source: { imageId: 'img-1', regionSourceId: 'r1' },
          target: { imageId: 'img-2' },
          direction: 'forward',
          relation: 'r',
          properties: {},
          confidence: null,
          note: '',
          sheetName: 'Other sheet',
        },
      ],
    };
    const elements = [
      image('e1', 'img-1', 0, 0, 200, 200),
      image('e2', 'img-2', 500, 0, 200, 200),
    ];
    const shapes = foreignShapes(rows, elements);
    const edge = shapes.find((s) => s.kind === 'edge');
    if (!edge || edge.kind !== 'edge')
      throw new Error('expected an edge shape');
    expect(edge.danglingStart).toBe(false);
    expect(edge.danglingEnd).toBe(false);
  });

  test('a plain image-to-image end (no regionSourceId) is never dangling', () => {
    const rows: Foreign = {
      regions: [],
      edges: [
        {
          id: 'other:e1',
          sheetId: 'other',
          sourceId: 'e1',
          source: { imageId: 'img-1' },
          target: { imageId: 'img-2' },
          direction: 'forward',
          relation: 'r',
          properties: {},
          confidence: null,
          note: '',
          sheetName: 'Other sheet',
        },
      ],
    };
    const elements = [
      image('e1', 'img-1', 0, 0, 200, 200),
      image('e2', 'img-2', 500, 0, 200, 200),
    ];
    const shapes = foreignShapes(rows, elements);
    const edge = shapes.find((s) => s.kind === 'edge');
    if (!edge || edge.kind !== 'edge')
      throw new Error('expected an edge shape');
    expect(edge.danglingStart).toBe(false);
    expect(edge.danglingEnd).toBe(false);
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
