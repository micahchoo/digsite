// A persisted native scene must remain projectable after JSON storage and reload.
import { describe, expect, test } from 'bun:test';
import { imageGroupId, project } from '@digsite/shared';
import { applyPatch } from '../src/sheet/canvas/native/ops.ts';
import type { SceneElement } from '../src/sheet/canvas/types.ts';

function image(id: string, imageId: string, x: number): SceneElement {
  return {
    id,
    type: 'image',
    version: 1,
    versionNonce: 1,
    updated: 0,
    isDeleted: false,
    x,
    y: 100,
    width: 200,
    height: 200,
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

describe('native canvas persistence roundtrip', () => {
  test('legacy persisted shapes with indices, bounds and arrow geometry still project', () => {
    const legacyScene = [
      {
        id: 'img-a',
        type: 'image',
        version: 4,
        versionNonce: 91,
        updated: 42,
        isDeleted: false,
        x: 100,
        y: 100,
        width: 200,
        height: 200,
        index: 'a0',
        groupIds: ['g-img-image-a'],
        boundElements: [
          { id: 'region-1', type: 'rectangle' },
          { id: 'edge-1', type: 'arrow' },
        ],
        startBinding: null,
        endBinding: null,
        points: [],
        startArrowhead: null,
        endArrowhead: null,
        customData: { kind: 'image', imageId: 'image-a' },
      },
      {
        id: 'region-1',
        type: 'rectangle',
        version: 3,
        versionNonce: 45,
        updated: 43,
        isDeleted: false,
        x: 120,
        y: 130,
        width: 30,
        height: 25,
        index: 'a1',
        groupIds: ['g-img-image-a'],
        boundElements: [{ id: 'region-label', type: 'text' }],
        startBinding: null,
        endBinding: null,
        points: [],
        startArrowhead: null,
        endArrowhead: null,
        customData: {
          kind: 'region',
          imageId: 'image-a',
          label: 'legacy find',
          properties: {},
        },
      },
      {
        id: 'region-label',
        type: 'text',
        version: 1,
        versionNonce: 11,
        updated: 43,
        isDeleted: false,
        x: 120,
        y: 130,
        width: 30,
        height: 16,
        text: 'legacy find',
        index: 'a2',
        groupIds: ['g-img-image-a'],
        boundElements: null,
        startBinding: null,
        endBinding: null,
        points: [],
        startArrowhead: null,
        endArrowhead: null,
      },
      {
        id: 'img-b',
        type: 'image',
        version: 2,
        versionNonce: 27,
        updated: 44,
        isDeleted: false,
        x: 500,
        y: 100,
        width: 200,
        height: 200,
        index: 'b0',
        groupIds: ['g-img-image-b'],
        boundElements: [{ id: 'edge-1', type: 'arrow' }],
        startBinding: null,
        endBinding: null,
        points: [],
        startArrowhead: null,
        endArrowhead: null,
        customData: { kind: 'image', imageId: 'image-b' },
      },
      {
        id: 'edge-1',
        type: 'arrow',
        version: 5,
        versionNonce: 19,
        updated: 45,
        isDeleted: false,
        x: 300,
        y: 200,
        width: 400,
        height: 0,
        index: 'b1',
        groupIds: [],
        boundElements: [{ id: 'edge-label', type: 'text' }],
        startBinding: {
          elementId: 'img-a',
          fixedPoint: [0.5, 0.5],
          mode: 'orbit',
        },
        endBinding: {
          elementId: 'img-b',
          fixedPoint: [0.5, 0.5],
          mode: 'orbit',
        },
        points: [
          [0, 0],
          [400, 0],
        ],
        startArrowhead: null,
        endArrowhead: 'arrow',
        customData: {
          kind: 'edge',
          relation: 'near',
          direction: 'forward',
          properties: {},
        },
      },
      {
        id: 'edge-label',
        type: 'text',
        version: 1,
        versionNonce: 8,
        updated: 45,
        isDeleted: false,
        x: 480,
        y: 200,
        width: 80,
        height: 16,
        text: 'near',
        index: 'b2',
        groupIds: [],
        boundElements: null,
        startBinding: null,
        endBinding: null,
        points: [],
        startArrowhead: null,
        endArrowhead: null,
      },
    ] as unknown as SceneElement[];
    const persisted = JSON.parse(JSON.stringify(legacyScene)) as SceneElement[];
    const projected = project('sheet-legacy', persisted);
    expect(projected.unresolved).toBe(0);
    expect(projected.regions).toMatchObject([
      {
        sourceId: 'region-1',
        imageId: 'image-a',
        label: 'legacy find',
        fx: 0.1,
        fy: 0.15,
      },
    ]);
    expect(projected.edges).toMatchObject([
      {
        sourceId: 'edge-1',
        source: { imageId: 'image-a' },
        target: { imageId: 'image-b' },
        relation: 'near',
      },
    ]);
    expect(persisted.find((el) => el.id === 'edge-1')?.points).toEqual([
      [0, 0],
      [400, 0],
    ]);
    expect(persisted.find((el) => el.id === 'edge-1')?.endArrowhead).toBe(
      'arrow',
    );
    expect(persisted.find((el) => el.id === 'region-1')?.boundElements).toEqual(
      [{ id: 'region-label', type: 'text' }],
    );
  });

  test('stored scene reload preserves region and edge projections plus tombstones', () => {
    const seed = [
      image('img-a', 'image-a', 100),
      image('img-b', 'image-b', 500),
    ];
    const edited = applyPatch(
      [
        {
          op: 'addRegion',
          id: 'region-1',
          imageId: 'image-a',
          groupId: imageGroupId('image-a'),
          rect: { x: 110, y: 120, width: 40, height: 30 },
          label: 'a find',
          properties: { material: 'bone' },
        },
        {
          op: 'addEdge',
          id: 'edge-1',
          fromId: 'img-a',
          toId: 'img-b',
          fromRect: { x: 100, y: 100, width: 200, height: 200 },
          toRect: { x: 500, y: 100, width: 200, height: 200 },
          relation: 'near',
          direction: 'forward',
          properties: { confidence: 'high' },
        },
      ],
      seed,
    );
    const deleted = applyPatch([{ op: 'remove', ids: ['region-1'] }], edited);
    const reloaded = JSON.parse(JSON.stringify(deleted)) as SceneElement[];
    const projected = project('sheet-1', reloaded);

    expect(projected.unresolved).toBe(0);
    expect(projected.regions).toEqual([]);
    expect(projected.edges).toEqual([
      {
        id: 'sheet-1:edge-1',
        sheetId: 'sheet-1',
        sourceId: 'edge-1',
        source: { imageId: 'image-a' },
        target: { imageId: 'image-b' },
        direction: 'forward',
        relation: 'near',
        properties: { confidence: 'high' },
      },
    ]);
    expect(reloaded.find((el) => el.id === 'region-1')).toMatchObject({
      isDeleted: true,
      version: 2,
    });
    expect(
      reloaded.find((el) => el.id === 'region-1')?.boundElements,
    ).toHaveLength(1);
  });
});
