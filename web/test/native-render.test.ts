import { describe, expect, test } from 'bun:test';
import { createCanvas } from '@napi-rs/canvas';
import { ImageCache } from '../src/sheet/canvas/native/images.ts';
import { renderFrame } from '../src/sheet/canvas/native/render.ts';
import type { SceneElement } from '../src/sheet/canvas/types.ts';

const edge: SceneElement = {
  id: 'edge-1',
  type: 'arrow',
  version: 1,
  versionNonce: 1,
  updated: 1,
  isDeleted: false,
  x: 20,
  y: 50,
  width: 60,
  height: 1,
  groupIds: [],
  boundElements: null,
  startBinding: null,
  endBinding: null,
  points: [
    [0, 0],
    [60, 0],
  ],
  startArrowhead: null,
  endArrowhead: null,
  customData: {
    kind: 'edge',
    relation: 'resembles',
    direction: 'none',
    properties: {},
  },
};

function pixelForFilter(dimRelations: string | null) {
  const canvas = createCanvas(100, 100);
  const ctx = canvas.getContext('2d');
  renderFrame({
    ctx: ctx as unknown as CanvasRenderingContext2D,
    width: 100,
    height: 100,
    viewport: { scrollX: 0, scrollY: 0, zoom: 1 },
    elements: [edge],
    selectedIds: new Set(),
    images: new ImageCache(),
    dimRelations,
  });
  return [...ctx.getImageData(50, 50, 1, 1).data];
}

describe('native connection emphasis', () => {
  test('dims nonmatching edge pixels without mutating the scene element', () => {
    const before = structuredClone(edge);
    const normal = pixelForFilter(null);
    const matching = pixelForFilter('resembles');
    const dimmed = pixelForFilter('other relation');

    expect(matching).toEqual(normal);
    expect(dimmed[0]).toBeGreaterThan(normal[0] ?? 0);
    expect(dimmed[1]).toBeGreaterThan(normal[1] ?? 0);
    expect(edge).toEqual(before);
  });
});
