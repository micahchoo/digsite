// Pure parts of the drawing tools: clamp-only-rewrites-when-changed
// (../src/sheet/clamp.ts), the delete cascade + dangling rebind
// (../src/sheet/dangling.ts), the label width/truncation contract
// (../src/sheet/labels.ts — the 200-char label case), and the point hit
// test (../src/sheet/hit.ts). No DOM, no Excalidraw import: every element
// here is a plain object shaped like the piece under test needs.
import { describe, expect, test } from 'bun:test';
import { imageGroupId } from '@digsite/shared';
import { clampRegion } from '../src/sheet/clamp.ts';
import {
  type CascadeElement,
  applyCascade,
  isDangling,
} from '../src/sheet/dangling.ts';
import { hitAt } from '../src/sheet/hit.ts';
import {
  LABEL_MAX_CHARS,
  regionLabelWidth,
  truncateLabel,
} from '../src/sheet/labels.ts';

const IMG = { x: 0, y: 0, width: 200, height: 100 };

describe('clampRegion', () => {
  test('a region already inside its image needs no rewrite', () => {
    expect(
      clampRegion({ x: 10, y: 10, width: 20, height: 20 }, IMG),
    ).toBeNull();
  });

  test('a region dragged past the edge is clamped and rewritten', () => {
    const rect = clampRegion({ x: 190, y: 10, width: 40, height: 20 }, IMG);
    expect(rect).not.toBeNull();
    if (!rect) throw new Error('expected a clamp');
    expect(rect.x + rect.width).toBeLessThanOrEqual(IMG.x + IMG.width + 0.01);
  });

  test('clamping to the same rect it started at (fraction already in [0,1]) is not a rewrite', () => {
    // fx=0.5,fy=0.5,fw=0.5,fh=0.5 clamps to itself: no change, so no rewrite.
    const rect = { x: 100, y: 50, width: 100, height: 50 };
    expect(clampRegion(rect, IMG)).toBeNull();
  });
});

describe('labels', () => {
  test('a 200-character label truncates for display without touching the region', () => {
    const longLabel = 'x'.repeat(200);
    const text = truncateLabel(longLabel);
    expect(text.length).toBe(LABEL_MAX_CHARS);
    expect(text.endsWith('…')).toBe(true);
  });

  test('a short label passes through unchanged', () => {
    expect(truncateLabel('find')).toBe('find');
  });

  test("the label's box width comes from the region's rect, never the label string", () => {
    const rect = { width: 80 };
    expect(regionLabelWidth(rect)).toBe(80);
    // A 200-char label changes nothing about the width computation — the
    // function does not even take the label as a parameter.
    expect(regionLabelWidth({ width: 5 })).toBeGreaterThan(0);
  });
});

describe('hitAt', () => {
  const image = {
    id: 'img-el',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    customData: { kind: 'image', imageId: 'img-1' },
  };
  const region = {
    id: 'region-el',
    x: 10,
    y: 10,
    width: 20,
    height: 20,
    customData: {
      kind: 'region',
      imageId: 'img-1',
      label: '',
      properties: {},
    },
  };

  test('a point over the region (drawn on top) hits the region, not the image beneath', () => {
    expect(hitAt({ x: 15, y: 15 }, [image, region])).toEqual({
      id: 'region-el',
      kind: 'region',
      imageId: 'img-1',
    });
  });

  test('a point over the image outside any region hits the image', () => {
    expect(hitAt({ x: 80, y: 80 }, [image, region])).toEqual({
      id: 'img-el',
      kind: 'image',
      imageId: 'img-1',
    });
  });

  test('a point over empty canvas hits nothing', () => {
    expect(hitAt({ x: 500, y: 500 }, [image, region])).toBeNull();
  });

  test('a deleted element is never a hit', () => {
    expect(
      hitAt({ x: 15, y: 15 }, [image, { ...region, isDeleted: true }]),
    ).toEqual({ id: 'img-el', kind: 'image', imageId: 'img-1' });
  });
});

describe('applyCascade', () => {
  function image(id: string, imageId: string, x: number): CascadeElement {
    return {
      id,
      x,
      y: 0,
      width: 100,
      height: 100,
      groupIds: [imageGroupId(imageId)],
      customData: { kind: 'image', imageId },
    };
  }
  function region(
    id: string,
    imageId: string,
    rect: { x: number; y: number; width: number; height: number },
  ): CascadeElement {
    return {
      id,
      ...rect,
      groupIds: [imageGroupId(imageId)],
      customData: { kind: 'region', imageId, label: '', properties: {} },
    };
  }
  function edge(
    id: string,
    from: { x: number; y: number },
    to: { x: number; y: number },
    startId: string,
    endId: string,
  ): CascadeElement {
    return {
      id,
      x: from.x,
      y: from.y,
      width: Math.abs(to.x - from.x) || 1,
      height: Math.abs(to.y - from.y) || 1,
      points: [
        [0, 0],
        [to.x - from.x, to.y - from.y],
      ],
      startBinding: {
        elementId: startId,
        fixedPoint: [0.5, 0.5],
        mode: 'orbit',
      },
      endBinding: { elementId: endId, fixedPoint: [0.5, 0.5], mode: 'orbit' },
      customData: {
        kind: 'edge',
        relation: 'r',
        direction: 'forward',
        properties: {},
      },
    };
  }

  test('deleting an image deletes its regions and any edge touching them', () => {
    const img1 = image('img1', 'a', 0);
    const img2 = image('img2', 'b', 200);
    const r1 = region('r1', 'a', { x: 10, y: 10, width: 10, height: 10 });
    const e1 = edge('e1', { x: 15, y: 15 }, { x: 215, y: 15 }, 'r1', 'img2');

    const { elements, changed } = applyCascade([
      { ...img1, isDeleted: true },
      img2,
      r1,
      e1,
    ]);
    expect(changed).toBe(true);
    const byId = new Map(elements.map((e) => [e.id, e]));
    expect(byId.get('r1')?.isDeleted).toBe(true);
    expect(byId.get('e1')?.isDeleted).toBe(true);
    expect(byId.get('img2')?.isDeleted).toBeFalsy();
  });

  test('an edge on a region Excalidraw already deleted in the SAME group-delete is still swept', () => {
    // Regression: clicking an image selects the whole group (image + its
    // regions, shared groupIds) — a real Delete keypress hands applyCascade
    // an elements array where the region is ALREADY isDeleted alongside its
    // image, in the one onChange call. An earlier version only collected
    // "regions still live in a dead group", so a region arriving pre-deleted
    // was invisible to the edge sweep and its edge outlived both.
    const img1 = image('img1', 'a', 0);
    const img2 = image('img2', 'b', 200);
    const r1 = region('r1', 'a', { x: 10, y: 10, width: 10, height: 10 });
    const e1 = edge('e1', { x: 15, y: 15 }, { x: 215, y: 15 }, 'r1', 'img2');

    const { elements, changed } = applyCascade([
      { ...img1, isDeleted: true },
      img2,
      { ...r1, isDeleted: true }, // already deleted, same as img1, by Excalidraw's own group delete
      e1,
    ]);
    expect(changed).toBe(true);
    const byId = new Map(elements.map((e) => [e.id, e]));
    expect(byId.get('e1')?.isDeleted).toBe(true);
  });

  test('an image delete still sweeps its edge when Excalidraw has already nulled the binding', () => {
    // Measured against the running app: a real Delete keypress goes through
    // Excalidraw's own actionDeleteSelected -> fixBindingsAfterDeletion,
    // which NULLS the arrow's binding to whatever it just deleted before
    // onChange ever runs. `boundElements` on the deleted element survives
    // that (Excalidraw only mutates the still-live side) and is what this
    // regression exercises: the edge's own startBinding is already null,
    // exactly like a real native delete hands it to us.
    const img1 = image('img1', 'a', 0);
    const img2 = image('img2', 'b', 200);
    const r1 = {
      ...region('r1', 'a', { x: 10, y: 10, width: 10, height: 10 }),
      isDeleted: true,
      boundElements: [{ id: 'e1', type: 'arrow' }],
    };
    const e1 = {
      ...edge('e1', { x: 15, y: 15 }, { x: 215, y: 15 }, 'r1', 'img2'),
      startBinding: null, // already nulled by Excalidraw itself
    };

    const { elements, changed } = applyCascade([
      { ...img1, isDeleted: true, boundElements: [] },
      img2,
      r1,
      e1,
    ]);
    expect(changed).toBe(true);
    const byId = new Map(elements.map((e) => [e.id, e]));
    expect(byId.get('e1')?.isDeleted).toBe(true);
  });

  test('a region-only delete rebinds its edge even when Excalidraw has already nulled that side', () => {
    const img1 = image('img1', 'a', 0);
    const img2 = image('img2', 'b', 200);
    const r1 = {
      ...region('r1', 'a', { x: 10, y: 10, width: 10, height: 10 }),
      isDeleted: true,
      boundElements: [{ id: 'e1', type: 'arrow' }],
    };
    const e1 = {
      ...edge('e1', { x: 15, y: 15 }, { x: 215, y: 15 }, 'r1', 'img2'),
      startBinding: null, // already nulled; img1 survives, so this is a rebind, not a delete
    };

    const { elements, changed } = applyCascade([img1, img2, r1, e1]);
    expect(changed).toBe(true);
    const byId = new Map(elements.map((e) => [e.id, e]));
    const rebound = byId.get('e1');
    expect(rebound?.isDeleted).toBeFalsy();
    expect(rebound?.startBinding?.elementId).toBe('img1');
    expect(isDangling(rebound as { customData?: unknown })).toBe(true);
  });

  test('deleting a region whose image survives rebinds its edge to the image instead of deleting it', () => {
    const img1 = image('img1', 'a', 0);
    const img2 = image('img2', 'b', 200);
    const r1 = {
      ...region('r1', 'a', { x: 10, y: 10, width: 10, height: 10 }),
      isDeleted: true,
    };
    const e1 = edge('e1', { x: 15, y: 15 }, { x: 215, y: 15 }, 'r1', 'img2');

    const { elements, changed } = applyCascade([img1, img2, r1, e1]);
    expect(changed).toBe(true);
    const byId = new Map(elements.map((e) => [e.id, e]));
    const rebound = byId.get('e1');
    expect(rebound?.isDeleted).toBeFalsy();
    expect(rebound?.startBinding?.elementId).toBe('img1');
    expect(isDangling(rebound as { customData?: unknown })).toBe(true);
    // the untouched end keeps its own binding
    expect(rebound?.endBinding?.elementId).toBe('img2');
    // a hollow marker on the rebound end only (docs/phases/2-sheet.md
    // section 5: "a hollow arrowhead marker")
    expect(rebound?.startArrowhead).toBe('triangle_outline');
  });

  test('is idempotent: running twice on an already-cascaded scene changes nothing further', () => {
    const img1 = image('img1', 'a', 0);
    const img2 = image('img2', 'b', 200);
    const r1 = {
      ...region('r1', 'a', { x: 10, y: 10, width: 10, height: 10 }),
      isDeleted: true,
    };
    const e1 = edge('e1', { x: 15, y: 15 }, { x: 215, y: 15 }, 'r1', 'img2');

    const once = applyCascade([img1, img2, r1, e1]);
    const twice = applyCascade(once.elements);
    expect(twice.changed).toBe(false);
    expect(twice.elements).toEqual(once.elements);
  });

  test('a scene with nothing deleted is unchanged', () => {
    const img1 = image('img1', 'a', 0);
    const r1 = region('r1', 'a', { x: 10, y: 10, width: 10, height: 10 });
    const { changed } = applyCascade([img1, r1]);
    expect(changed).toBe(false);
  });
});
