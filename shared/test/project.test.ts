import { describe, expect, test } from 'bun:test';
import { type SceneElement, project } from '../src/sheet/project.ts';

function image(
  id: string,
  imageId: string,
  rect: Partial<SceneElement> = {},
): SceneElement {
  return {
    id,
    version: 1,
    versionNonce: 1,
    type: 'image',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    customData: { kind: 'image', imageId },
    ...rect,
  };
}

function region(
  id: string,
  imageId: string,
  rect: { x: number; y: number; width: number; height: number },
  extra: Partial<SceneElement> = {},
): SceneElement {
  return {
    id,
    version: 1,
    versionNonce: 1,
    type: 'rectangle',
    ...rect,
    customData: { kind: 'region', imageId, label: 'face', properties: {} },
    ...extra,
  };
}

function edge(
  id: string,
  startId: string,
  endId: string,
  extra: Partial<SceneElement> = {},
): SceneElement {
  return {
    id,
    version: 1,
    versionNonce: 1,
    type: 'arrow',
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    customData: {
      kind: 'edge',
      relation: 'resembles',
      direction: 'forward',
      properties: {},
    },
    startBinding: { elementId: startId },
    endBinding: { elementId: endId },
    ...extra,
  };
}

describe('project', () => {
  test('one image + one region + one edge produce rows with correct fractions and edge ends', () => {
    const img = image('img1', 'IMG-A');
    const reg = region('reg1', 'IMG-A', {
      x: 10,
      y: 20,
      width: 50,
      height: 25,
    });
    const e = edge('edge1', 'img1', 'reg1');

    const { regions, edges, unresolved } = project('sheet-1', [img, reg, e]);

    expect(unresolved).toBe(0);
    expect(regions).toEqual([
      {
        id: 'sheet-1:reg1',
        sheetId: 'sheet-1',
        sourceId: 'reg1',
        imageId: 'IMG-A',
        fx: 0.1,
        fy: 0.2,
        fw: 0.5,
        fh: 0.25,
        label: 'face',
        properties: {},
      },
    ]);
    expect(edges).toEqual([
      {
        id: 'sheet-1:edge1',
        sheetId: 'sheet-1',
        sourceId: 'edge1',
        source: { imageId: 'IMG-A' },
        target: { imageId: 'IMG-A', regionSourceId: 'reg1' },
        direction: 'forward',
        relation: 'resembles',
        properties: {},
      },
    ]);
  });

  test('a region on an image not in the scene is unresolved and produces no row', () => {
    const reg = region('reg1', 'IMG-MISSING', {
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    });
    const { regions, unresolved } = project('sheet-1', [reg]);
    expect(regions).toEqual([]);
    expect(unresolved).toBe(1);
  });

  test('a deleted region produces no row', () => {
    const img = image('img1', 'IMG-A');
    const reg = region(
      'reg1',
      'IMG-A',
      { x: 0, y: 0, width: 10, height: 10 },
      { isDeleted: true },
    );
    const { regions, unresolved } = project('sheet-1', [img, reg]);
    expect(regions).toEqual([]);
    expect(unresolved).toBe(0);
  });

  test('an edge bound to a region sets regionSourceId on that end', () => {
    const img = image('img1', 'IMG-A');
    const reg = region('reg1', 'IMG-A', { x: 0, y: 0, width: 10, height: 10 });
    const e = edge('edge1', 'reg1', 'img1');
    const { edges } = project('sheet-1', [img, reg, e]);
    expect(edges[0]?.source).toEqual({
      imageId: 'IMG-A',
      regionSourceId: 'reg1',
    });
    expect(edges[0]?.target).toEqual({ imageId: 'IMG-A' });
  });
});
