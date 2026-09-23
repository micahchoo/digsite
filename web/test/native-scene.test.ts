// canvas/native/scene.ts: what is on screen and what a point lands on.
// The hit test must measure the SAME thing `render.ts` draws — an edge's
// segment from its own `x`/`y`/`points`, never a chord recomputed from
// somewhere else — per ../../.claude/rules/image-graph-hit-what-was-drawn.md.
import { describe, expect, test } from 'bun:test';
import { imageGroupId } from '@digsite/shared';
import {
  groupMembers,
  hitAt,
  hitGrip,
  marqueeSelect,
  paintOrder,
  regionHandles,
  resizeRegion,
  retargetEdges,
  selectedGroupMembers,
} from '../src/sheet/canvas/native/scene.ts';
import type { SceneElement } from '../src/sheet/canvas/types.ts';
import { edgePaths, midSegment } from '../src/sheet/routing.ts';

let seq = 0;
function element(
  partial: Partial<SceneElement> & { id: string },
): SceneElement {
  seq++;
  return {
    type: 'rectangle',
    version: 1,
    versionNonce: seq,
    updated: 0,
    isDeleted: false,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    groupIds: [],
    boundElements: null,
    startBinding: null,
    endBinding: null,
    points: [],
    startArrowhead: null,
    endArrowhead: null,
    ...partial,
  };
}

function image(
  id: string,
  imageId: string,
  rect: { x: number; y: number; width: number; height: number },
) {
  return element({
    id,
    type: 'image',
    customData: { kind: 'image', imageId },
    ...rect,
  });
}
function region(
  id: string,
  imageId: string,
  rect: { x: number; y: number; width: number; height: number },
) {
  return element({
    id,
    type: 'rectangle',
    customData: { kind: 'region', imageId, label: '', properties: {} },
    groupIds: [imageGroupId(imageId)],
    ...rect,
  });
}
function edge(
  id: string,
  fromId: string,
  toId: string,
  start: { x: number; y: number },
  end: { x: number; y: number },
) {
  return element({
    id,
    type: 'arrow',
    customData: {
      kind: 'edge',
      relation: '',
      direction: 'forward',
      properties: {},
    },
    startBinding: { elementId: fromId },
    endBinding: { elementId: toId },
    x: start.x,
    y: start.y,
    width: Math.abs(end.x - start.x) || 1,
    height: Math.abs(end.y - start.y) || 1,
    points: [
      [0, 0],
      [end.x - start.x, end.y - start.y],
    ],
  });
}

describe('hitAt', () => {
  test('finds the topmost image or region under a point', () => {
    const elements = [
      image('img-1', 'i1', { x: 0, y: 0, width: 100, height: 100 }),
      region('r-1', 'i1', { x: 10, y: 10, width: 20, height: 20 }),
    ];
    expect(hitAt({ x: 50, y: 50 }, elements, 1)).toEqual({
      id: 'img-1',
      kind: 'image',
      imageId: 'i1',
    });
    expect(hitAt({ x: 15, y: 15 }, elements, 1)).toEqual({
      id: 'r-1',
      kind: 'region',
      imageId: 'i1',
    });
    expect(hitAt({ x: 500, y: 500 }, elements, 1)).toBeNull();
  });

  test("measures what was drawn: a click on an edge's midpoint selects the edge", () => {
    const elements = [
      image('img-1', 'i1', { x: 0, y: 0, width: 50, height: 50 }),
      image('img-2', 'i2', { x: 400, y: 400, width: 50, height: 50 }),
      edge('e-1', 'img-1', 'img-2', { x: 25, y: 25 }, { x: 425, y: 425 }),
    ];
    const midpoint = { x: 225, y: 225 };
    expect(hitAt(midpoint, elements, 1)).toEqual({ id: 'e-1', kind: 'edge' });
  });

  test('refuses a point that only looks close on a straight chord between the ends', () => {
    // The segment actually drawn runs from (25,25) to (425,425) — a point
    // near the midpoint of a DIFFERENT line (e.g. a would-be routed detour)
    // must not hit, proving the test measures the real points, not a
    // recomputed chord between endpoint centres.
    const elements = [
      image('img-1', 'i1', { x: 0, y: 0, width: 50, height: 50 }),
      image('img-2', 'i2', { x: 400, y: 400, width: 50, height: 50 }),
      edge('e-1', 'img-1', 'img-2', { x: 25, y: 25 }, { x: 425, y: 425 }),
    ];
    const offLine = { x: 225, y: 100 }; // far from the actual diagonal
    expect(hitAt(offLine, elements, 1)).toBeNull();
  });

  test('the edge reach shrinks with zoom (world units, not screen units)', () => {
    const elements = [
      image('img-1', 'i1', { x: 0, y: 0, width: 10, height: 10 }),
      image('img-2', 'i2', { x: 100, y: 0, width: 10, height: 10 }),
      edge('e-1', 'img-1', 'img-2', { x: 5, y: 5 }, { x: 105, y: 5 }),
    ];
    const near = { x: 55, y: 11 }; // 6 world units off the line
    expect(hitAt(near, elements, 1)).toEqual({ id: 'e-1', kind: 'edge' }); // reach 7 at scale 1
    expect(hitAt(near, elements, 10)).toBeNull(); // reach .7 at scale 10
  });
});

describe('groupMembers', () => {
  test('carries the image, its regions and their bound labels — never an edge', () => {
    const img = image('img-1', 'i1', { x: 0, y: 0, width: 100, height: 100 });
    const label = element({ id: 'label-1', type: 'text', text: 'find' });
    const reg = element({
      ...region('r-1', 'i1', { x: 10, y: 10, width: 20, height: 20 }),
      boundElements: [{ id: 'label-1', type: 'text' }],
    });
    const otherImg = image('img-2', 'i2', {
      x: 200,
      y: 200,
      width: 100,
      height: 100,
    });
    const e = edge(
      'e-1',
      'img-1',
      'img-2',
      { x: 50, y: 50 },
      { x: 250, y: 250 },
    );
    const members = groupMembers([img, label, reg, otherImg, e], 'i1');
    expect(members).toEqual(new Set(['img-1', 'r-1', 'label-1']));
  });

  test('dragging a selected image carries each selected image group together', () => {
    const img1 = image('img-1', 'i1', { x: 0, y: 0, width: 100, height: 100 });
    const reg1 = region('r-1', 'i1', { x: 10, y: 10, width: 20, height: 20 });
    const img2 = image('img-2', 'i2', {
      x: 200,
      y: 200,
      width: 100,
      height: 100,
    });
    const reg2 = region('r-2', 'i2', {
      x: 210,
      y: 210,
      width: 20,
      height: 20,
    });
    const img3 = image('img-3', 'i3', {
      x: 400,
      y: 400,
      width: 100,
      height: 100,
    });
    expect(
      selectedGroupMembers([img1, reg1, img2, reg2, img3], 'img-1', [
        'img-1',
        'img-2',
      ]),
    ).toEqual(new Set(['img-1', 'r-1', 'img-2', 'r-2']));
    expect(
      selectedGroupMembers([img1, reg1, img2, reg2, img3], 'img-3', [
        'img-1',
        'img-2',
      ]),
    ).toEqual(new Set(['img-3']));
  });
});

describe('retargetEdges', () => {
  test('follows a bound element that moved, leaving an unrelated edge untouched', () => {
    const img1 = image('img-1', 'i1', { x: 0, y: 0, width: 10, height: 10 });
    const img2 = image('img-2', 'i2', { x: 90, y: 0, width: 10, height: 10 });
    const stale = edge(
      'e-1',
      'img-1',
      'img-2',
      { x: 5, y: 5 },
      { x: 95, y: 5 },
    );
    const moved = { ...img1, x: 200, y: 200 };
    const result = retargetEdges([moved, img2, stale]);
    const followed = result.find((e) => e.id === 'e-1');
    expect(followed?.x).toBeCloseTo(205, 6);
    expect(followed?.y).toBeCloseTo(205, 6);

    // Nothing moved: the array comes back with the SAME references
    // (identity-diffable, per ops.ts#diffForHistory's contract).
    const settled = retargetEdges([moved, img2, followed as SceneElement]);
    expect(settled[2]).toBe(followed);
  });

  test('leaves an edge alone when its bound element is gone (the delete cascade handles that)', () => {
    const img1 = image('img-1', 'i1', { x: 0, y: 0, width: 10, height: 10 });
    const img2Deleted = {
      ...image('img-2', 'i2', { x: 90, y: 0, width: 10, height: 10 }),
      isDeleted: true,
    };
    const e = edge('e-1', 'img-1', 'img-2', { x: 5, y: 5 }, { x: 95, y: 5 });
    const result = retargetEdges([img1, img2Deleted, e]);
    expect(result.find((x) => x.id === 'e-1')).toBe(e);
  });
});

describe('grips', () => {
  const rect = { x: 100, y: 100, width: 40, height: 20 };

  test('regionHandles places eight grips at the rect fractions', () => {
    const handles = regionHandles(rect);
    expect(handles).toHaveLength(8);
    expect(handles.find((h) => h.id === 'nw')).toEqual({
      id: 'nw',
      x: 100,
      y: 100,
    });
    expect(handles.find((h) => h.id === 'se')).toEqual({
      id: 'se',
      x: 140,
      y: 120,
    });
  });

  test('hitGrip finds the nearest grip within reach, and null past it', () => {
    expect(hitGrip({ x: 100, y: 100 }, rect, 6)).toBe('nw');
    expect(hitGrip({ x: 200, y: 200 }, rect, 6)).toBeNull();
  });

  test('resizeRegion keeps the rect legal: never inverted, never smaller than the minimum', () => {
    const grown = resizeRegion(rect, 'se', { x: 200, y: 150 });
    expect(grown).toEqual({ x: 100, y: 100, width: 100, height: 50 });

    // Dragging the 'se' handle PAST the opposite ('nw') corner must not
    // invert the rectangle.
    const inverted = resizeRegion(rect, 'se', { x: 50, y: 90 });
    expect(inverted.x).toBeLessThanOrEqual(100);
    expect(inverted.width).toBeGreaterThan(0);
    expect(inverted.height).toBeGreaterThan(0);
  });
});

describe('marqueeSelect', () => {
  test('picks every image/region overlapping the band, never an edge', () => {
    const elements = [
      image('img-1', 'i1', { x: 0, y: 0, width: 20, height: 20 }),
      region('r-1', 'i1', { x: 5, y: 5, width: 5, height: 5 }),
      image('img-2', 'i2', { x: 500, y: 500, width: 20, height: 20 }),
      edge('e-1', 'img-1', 'img-2', { x: 10, y: 10 }, { x: 510, y: 510 }),
    ];
    const band = { x: -10, y: -10, width: 40, height: 40 };
    expect(new Set(marqueeSelect(elements, band))).toEqual(
      new Set(['img-1', 'r-1']),
    );
  });
});

// A saved native scene carries no fractional index, and the server's merge
// once sorted it by id: edges and regions (random uuids) came back before
// their images, and a reload drew every claim underneath its picture.
describe('claims stay above images, whatever the saved order', () => {
  const a = image('img-a', 'A', { x: 0, y: 0, width: 200, height: 200 });
  const c = image('img-c', 'C', { x: 300, y: 0, width: 200, height: 200 });
  const b = image('img-b', 'B', { x: 600, y: 0, width: 200, height: 200 });
  const r = region('0-region', 'A', { x: 20, y: 20, width: 50, height: 50 });
  // A to B, centre to centre, passing over the whole width of image C.
  const e = edge(
    '0-edge',
    'img-a',
    'img-b',
    { x: 100, y: 100 },
    { x: 700, y: 100 },
  );
  const saved = [e, r, a, c, b];

  test('paint order is images, then regions, then connections', () => {
    expect(paintOrder(saved).map((el) => el.id)).toEqual([
      'img-a',
      'img-c',
      'img-b',
      '0-region',
      '0-edge',
    ]);
  });

  test('zoomed far out, a connection is drawn straight, border to border', () => {
    expect(edgePaths(saved, 0.05).get('0-edge')).toEqual([
      { x: 200, y: 100 },
      { x: 600, y: 100 },
    ]);
    // …and there, where it crosses another image, a click hits the line.
    expect(hitAt({ x: 400, y: 100 }, saved, 0.05)?.id).toBe('0-edge');
  });

  test('otherwise it goes around the image between its ends', () => {
    const path = edgePaths(saved, 1).get('0-edge') ?? [];
    expect(path.length).toBeGreaterThan(2);
    // It leaves A through its border and arrives through B's.
    expect(path[0]).toEqual({ x: 100, y: 200 });
    expect(path.at(-1)).toEqual({ x: 700, y: 200 });
    // No point of it lies inside C, and C is what a click on C selects.
    for (const p of path)
      expect(p.x > 300 && p.x < 500 && p.y > 0 && p.y < 200).toBe(false);
    expect(hitAt({ x: 400, y: 100 }, saved, 1)?.id).toBe('img-c');
    // A click on the route, over C, selects the line.
    const [a, b] = midSegment(path);
    expect(
      hitAt({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, saved, 1)?.id,
    ).toBe('0-edge');
  });

  test('a click on an image the connection joins selects the image', () => {
    expect(hitAt({ x: 100, y: 100 }, saved, 1)?.id).toBe('img-a');
    expect(hitAt({ x: 700, y: 100 }, saved, 1)?.id).toBe('img-b');
  });

  test('a region saved before its image is still hit over the image', () => {
    expect(hitAt({ x: 40, y: 40 }, saved, 1)?.id).toBe('0-region');
  });
});
