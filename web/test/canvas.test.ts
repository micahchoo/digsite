// The pure parts of the canvas seam (.claude/rules/sheet-canvas-seam.md):
// type conversion both ways, patch application, and the scene-change
// diffing Sheet.tsx's onChange runs (scene-diff.ts). Needs
// `test/dom-shim.ts` (wired through bunfig.toml's `[test].preload`) because
// `@excalidraw/excalidraw` touches `window` at module load — see that
// file's header comment.
import { describe, expect, test } from 'bun:test';
import { imageGroupId } from '@digsite/shared';
import {
  applyPatch,
  fitViewport,
  orderByIndex,
  repairBoundTextOrder,
  sceneForCanvasChange,
  toSceneElement,
  zoomBy,
} from '../src/sheet/canvas/excalidraw/convert.ts';
import type { SceneElement } from '../src/sheet/canvas/types.ts';
import { reconcileLocalChange } from '../src/sheet/scene-diff.ts';

// A minimal object shaped like an ExcalidrawElement — every field
// toSceneElement reads. Cast at the call site the same way
// production code casts a live Excalidraw element it did not construct.
function fakeExcalidrawElement(partial: Record<string, unknown>) {
  return {
    id: 'el-1',
    type: 'rectangle',
    version: 3,
    versionNonce: 12345,
    updated: 1_700_000_000_000,
    isDeleted: false,
    x: 10,
    y: 20,
    width: 30,
    height: 40,
    customData: {
      kind: 'region',
      imageId: 'img-1',
      label: 'find',
      properties: {},
    },
    groupIds: ['g-img-img-1'],
    boundElements: [{ id: 'text-1', type: 'text' }],
    startBinding: null,
    endBinding: null,
    points: [],
    startArrowhead: null,
    endArrowhead: null,
    ...partial,
    // biome-ignore lint/suspicious/noExplicitAny: a hand-built element for a test fixture, not a real Excalidraw type
  } as any;
}

describe('Excalidraw onChange commit ordering', () => {
  test('a rapid stale callback cannot replace an applied delete tombstone', () => {
    const deleted = [
      { id: 'region-1', version: 8, isDeleted: true },
      { id: 'image-1', version: 1, isDeleted: false },
    ];
    const stale = [
      { id: 'region-1', version: 7, isDeleted: false },
      { id: 'image-1', version: 1, isDeleted: false },
    ];
    const caughtUp = [
      { id: 'region-1', version: 8, isDeleted: true },
      { id: 'image-1', version: 1, isDeleted: false },
    ];

    expect(sceneForCanvasChange(deleted, stale)).toBe(deleted);
    expect(sceneForCanvasChange(deleted, caughtUp)).toBe(caughtUp);
  });
});

describe('toSceneElement', () => {
  test('round-trips every field the product reads off a scene element', () => {
    const el = fakeExcalidrawElement({});
    const scene = toSceneElement(el);
    expect(scene).toEqual({
      id: 'el-1',
      type: 'rectangle',
      version: 3,
      versionNonce: 12345,
      updated: 1_700_000_000_000,
      isDeleted: false,
      x: 10,
      y: 20,
      width: 30,
      height: 40,
      customData: {
        kind: 'region',
        imageId: 'img-1',
        label: 'find',
        properties: {},
      },
      groupIds: ['g-img-img-1'],
      boundElements: [{ id: 'text-1', type: 'text' }],
      startBinding: null,
      endBinding: null,
      points: [],
      startArrowhead: null,
      endArrowhead: null,
      text: undefined,
    });
  });

  test('an arrow keeps its bindings, points and arrowheads', () => {
    const el = fakeExcalidrawElement({
      type: 'arrow',
      customData: {
        kind: 'edge',
        relation: 'near',
        direction: 'forward',
        properties: {},
      },
      points: [
        [0, 0],
        [50, 60],
      ],
      startBinding: {
        elementId: 'img-a',
        fixedPoint: [0.5, 0.5],
        mode: 'orbit',
      },
      endBinding: { elementId: 'img-b', fixedPoint: [0.5, 0.5], mode: 'orbit' },
      startArrowhead: null,
      endArrowhead: 'arrow',
    });
    const scene = toSceneElement(el);
    expect(scene.points).toEqual([
      [0, 0],
      [50, 60],
    ]);
    expect(scene.startBinding?.elementId).toBe('img-a');
    expect(scene.endBinding?.elementId).toBe('img-b');
    expect(scene.endArrowhead).toBe('arrow');
  });

  test('only a text element carries `text`', () => {
    const textEl = fakeExcalidrawElement({ type: 'text', text: 'hello' });
    expect(toSceneElement(textEl).text).toBe('hello');
    const rectEl = fakeExcalidrawElement({ type: 'rectangle' });
    expect(toSceneElement(rectEl).text).toBeUndefined();
  });

  test('missing optional fields fall back the same way a freshly restored element would', () => {
    const el = fakeExcalidrawElement({
      groupIds: undefined,
      boundElements: undefined,
      points: undefined,
      startArrowhead: undefined,
      endArrowhead: undefined,
      versionNonce: undefined,
    });
    const scene = toSceneElement(el);
    expect(scene.groupIds).toEqual([]);
    expect(scene.boundElements).toBeNull();
    expect(scene.points).toEqual([]);
    expect(scene.startArrowhead).toBeNull();
    expect(scene.endArrowhead).toBeNull();
    expect(scene.versionNonce).toBe(0);
  });
});

describe('applyPatch', () => {
  test('addRegion builds a rectangle at the given rect, in its image group', () => {
    const next = applyPatch(
      [
        {
          op: 'addRegion',
          id: 'r1',
          imageId: 'img-1',
          groupId: imageGroupId('img-1'),
          rect: { x: 5, y: 6, width: 70, height: 80 },
          label: 'a find',
          properties: { year: 1950 },
        },
      ],
      [],
    );
    const region = next.find((e) => e.id === 'r1');
    expect(region).toBeDefined();
    expect(region?.x).toBe(5);
    expect(region?.y).toBe(6);
    expect(region?.width).toBe(70);
    expect(region?.height).toBe(80);
    // biome-ignore lint/suspicious/noExplicitAny: reading customData off a live Excalidraw element for the assertion
    const data = (region as any)?.customData;
    expect(data).toEqual({
      kind: 'region',
      imageId: 'img-1',
      label: 'a find',
      properties: { year: 1950 },
    });
    // a long label never regrows the rect (tools.ts#drawRegion's own contract)
    expect(region?.width).toBe(70);
  });

  test('addEdge builds an arrow bound to both ends, and binds each end back to it', () => {
    const current = [
      fakeExcalidrawElement({
        id: 'img-a',
        type: 'image',
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        boundElements: [],
      }),
      fakeExcalidrawElement({
        id: 'img-b',
        type: 'image',
        x: 500,
        y: 0,
        width: 100,
        height: 100,
        boundElements: [],
      }),
    ];
    const next = applyPatch(
      [
        {
          op: 'addEdge',
          id: 'e1',
          fromId: 'img-a',
          toId: 'img-b',
          fromRect: { x: 0, y: 0, width: 100, height: 100 },
          toRect: { x: 500, y: 0, width: 100, height: 100 },
          relation: 'near',
          direction: 'forward',
          properties: {},
        },
      ],
      current,
    );
    const arrow = next.find((e) => e.id === 'e1');
    expect(arrow).toBeDefined();
    // biome-ignore lint/suspicious/noExplicitAny: reading bindings off a live Excalidraw element for the assertion
    expect((arrow as any).startBinding.elementId).toBe('img-a');
    // biome-ignore lint/suspicious/noExplicitAny: see above
    expect((arrow as any).endBinding.elementId).toBe('img-b');
    const from = next.find((e) => e.id === 'img-a');
    const to = next.find((e) => e.id === 'img-b');
    // biome-ignore lint/suspicious/noExplicitAny: reading boundElements off a live Excalidraw element for the assertion
    expect((from as any).boundElements).toContainEqual({
      id: 'e1',
      type: 'arrow',
    });
    // biome-ignore lint/suspicious/noExplicitAny: see above
    expect((to as any).boundElements).toContainEqual({
      id: 'e1',
      type: 'arrow',
    });
  });

  test('update changes only the given fields and leaves everything else untouched', () => {
    const current = [fakeExcalidrawElement({ id: 'r1', x: 10, y: 20 })];
    const next = applyPatch(
      [{ op: 'update', id: 'r1', changes: { x: 99 } }],
      current,
    );
    const region = next.find((e) => e.id === 'r1');
    expect(region?.x).toBe(99);
    expect(region?.y).toBe(20);
    expect(region?.width).toBe(30);
  });

  test('update is a no-op for an id not present', () => {
    const current = [fakeExcalidrawElement({ id: 'r1' })];
    const next = applyPatch(
      [{ op: 'update', id: 'missing', changes: { x: 1 } }],
      current,
    );
    expect(next).toEqual(current);
  });

  test('remove marks isDeleted without touching other elements', () => {
    const current = [
      fakeExcalidrawElement({ id: 'r1' }),
      fakeExcalidrawElement({ id: 'r2' }),
    ];
    const next = applyPatch([{ op: 'remove', ids: ['r1'] }], current);
    expect(next.find((e) => e.id === 'r1')?.isDeleted).toBe(true);
    expect(next.find((e) => e.id === 'r2')?.isDeleted).toBe(false);
  });

  test('remove is idempotent on an already-deleted element', () => {
    const current = [fakeExcalidrawElement({ id: 'r1', isDeleted: true })];
    const next = applyPatch([{ op: 'remove', ids: ['r1'] }], current);
    expect(next).toEqual(current);
  });
});

describe('fitViewport', () => {
  test('centres the box and picks the tighter of width/height zoom', () => {
    const v = fitViewport(
      [{ x: 0, y: 0, width: 200, height: 100 }],
      1000,
      1000,
      { scrollX: 0, scrollY: 0, zoom: 1 },
    );
    // available space is (1000 - 2*48) on each axis; width-constrained here
    // since the box is wider relative to its own height than the viewport is
    expect(v.zoom).toBeCloseTo((1000 - 96) / 200, 5);
  });

  test('an empty rect list leaves the viewport unchanged', () => {
    const current = { scrollX: 5, scrollY: 6, zoom: 2 };
    expect(fitViewport([], 800, 600, current)).toEqual(current);
  });

  test('clamps zoom to the same [0.1, 30] range the toolbar buttons respect', () => {
    const tiny = fitViewport(
      [{ x: 0, y: 0, width: 100000, height: 100000 }],
      500,
      500,
      {
        scrollX: 0,
        scrollY: 0,
        zoom: 1,
      },
    );
    expect(tiny.zoom).toBeGreaterThanOrEqual(0.1);
    const huge = fitViewport(
      [{ x: 0, y: 0, width: 1, height: 1 }],
      5000,
      5000,
      {
        scrollX: 0,
        scrollY: 0,
        zoom: 1,
      },
    );
    expect(huge.zoom).toBeLessThanOrEqual(30);
  });
});

describe('zoomBy', () => {
  test('holds the scene point under the anchor fixed', () => {
    const current = { scrollX: 0, scrollY: 0, zoom: 1 };
    const before = {
      x: 100 / current.zoom - current.scrollX,
      y: 100 / current.zoom - current.scrollY,
    };
    const next = zoomBy(current, 1.5, 100, 100);
    const after = {
      x: 100 / next.zoom - next.scrollX,
      y: 100 / next.zoom - next.scrollY,
    };
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    expect(next.zoom).toBeCloseTo(1.5, 6);
  });

  test('a factor that would leave the clamped range unchanged returns the same viewport', () => {
    const current = { scrollX: 3, scrollY: 4, zoom: 30 };
    expect(zoomBy(current, 2, 0, 0)).toBe(current);
  });
});

describe('reconcileLocalChange (scene-diff.ts)', () => {
  function image(id: string, imageId: string, x = 0): SceneElement {
    return {
      id,
      type: 'image',
      version: 1,
      versionNonce: 1,
      updated: 0,
      isDeleted: false,
      x,
      y: 0,
      width: 100,
      height: 100,
      customData: { kind: 'image', imageId },
      groupIds: [imageGroupId(imageId)],
      boundElements: null,
      startBinding: null,
      endBinding: null,
      points: [],
      startArrowhead: null,
      endArrowhead: null,
    };
  }
  function region(
    id: string,
    imageId: string,
    rect: { x: number; y: number; width: number; height: number },
  ): SceneElement {
    return {
      id,
      type: 'rectangle',
      version: 1,
      versionNonce: 1,
      updated: 0,
      isDeleted: false,
      ...rect,
      customData: { kind: 'region', imageId, label: '', properties: {} },
      groupIds: [imageGroupId(imageId)],
      boundElements: null,
      startBinding: null,
      endBinding: null,
      points: [],
      startArrowhead: null,
      endArrowhead: null,
    };
  }

  test('a region already inside its image produces no ops', () => {
    const els = [
      image('i1', 'img-1'),
      region('r1', 'img-1', { x: 10, y: 10, width: 20, height: 20 }),
    ];
    const { ops, elements } = reconcileLocalChange(els);
    expect(ops).toEqual([]);
    expect(elements).toEqual(els);
  });

  test('a region dragged outside its image produces one clamp update op', () => {
    const els = [
      image('i1', 'img-1'),
      region('r1', 'img-1', { x: 90, y: 10, width: 30, height: 20 }),
    ];
    const { ops, elements } = reconcileLocalChange(els);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ op: 'update', id: 'r1' });
    const rebuilt = elements.find((e) => e.id === 'r1');
    expect(rebuilt && rebuilt.x + rebuilt.width).toBeLessThanOrEqual(110.01);
  });

  test('deleting an image cascades ops for its region and edge', () => {
    const img1 = { ...image('i1', 'a'), isDeleted: true };
    const img2 = image('i2', 'b', 200);
    const r1 = region('r1', 'a', { x: 10, y: 10, width: 10, height: 10 });
    const e1: SceneElement = {
      id: 'e1',
      type: 'arrow',
      version: 1,
      versionNonce: 1,
      updated: 0,
      isDeleted: false,
      x: 15,
      y: 15,
      width: 200,
      height: 1,
      customData: {
        kind: 'edge',
        relation: 'r',
        direction: 'forward',
        properties: {},
      },
      groupIds: [],
      boundElements: null,
      startBinding: { elementId: 'r1' },
      endBinding: { elementId: 'i2' },
      points: [
        [0, 0],
        [200, 0],
      ],
      startArrowhead: null,
      endArrowhead: null,
    };
    const { ops, elements } = reconcileLocalChange([img1, img2, r1, e1]);
    expect(ops.length).toBeGreaterThan(0);
    expect(elements.find((e) => e.id === 'r1')?.isDeleted).toBe(true);
    expect(elements.find((e) => e.id === 'e1')?.isDeleted).toBe(true);
    expect(elements.find((e) => e.id === 'i2')?.isDeleted).toBeFalsy();
  });

  test('is idempotent: reconciling an already-settled scene produces no ops', () => {
    const els = [
      image('i1', 'img-1'),
      region('r1', 'img-1', { x: 10, y: 10, width: 20, height: 20 }),
    ];
    const once = reconcileLocalChange(els);
    const twice = reconcileLocalChange(once.elements);
    expect(twice.ops).toEqual([]);
  });
});

describe('repairBoundTextOrder', () => {
  test('moves a bound text that sorts before its container to right after it, index cleared', () => {
    const els = [
      { id: 'label', containerId: 'arrow', index: 'b0O' },
      { id: 'other', index: 'b0P' },
      { id: 'arrow', containerId: null, index: 'b0S' },
      { id: 'fine', containerId: 'arrow', index: 'b0T' },
    ];
    const out = repairBoundTextOrder(els);
    expect(out.map((e) => e.id)).toEqual(['other', 'arrow', 'label', 'fine']);
    expect(out.find((e) => e.id === 'label')?.index).toBeNull();
    expect(out.find((e) => e.id === 'fine')?.index).toBe('b0T');
  });
  test('a text bound only through boundElements, container unindexed, follows its container', () => {
    const els = [
      { id: 'label', index: 'aQ' },
      {
        id: 'rect',
        index: null,
        boundElements: [{ id: 'label', type: 'text' }],
      },
    ];
    const out = repairBoundTextOrder(els);
    expect(out.map((e) => e.id)).toEqual(['rect', 'label']);
    expect(out[1]?.index).toBeNull();
  });
  test('leaves a well-ordered scene untouched', () => {
    const els = [
      { id: 'arrow', index: 'a1' },
      { id: 'label', containerId: 'arrow', index: 'a2' },
    ];
    expect(repairBoundTextOrder(els)).toEqual(els);
  });
});

describe('orderByIndex', () => {
  test('sorts by fractional index, unindexed elements first in input order', () => {
    const els: { id: string; index?: string | null }[] = [
      { id: 'text', index: 'b0d' },
      { id: 'fresh1' },
      { id: 'arrow', index: 'b0c' },
      { id: 'fresh2', index: null },
      { id: 'rect', index: 'ah' },
    ];
    const out = orderByIndex(els);
    expect(out.map((e) => e.id)).toEqual([
      'fresh1',
      'fresh2',
      'rect',
      'arrow',
      'text',
    ]);
  });
});
