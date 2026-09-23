import { describe, expect, test } from 'bun:test';
import { imageGroupId } from '@digsite/shared';
import { applyPatch } from '../src/sheet/canvas/native/ops.ts';
import type { SceneElement } from '../src/sheet/canvas/types.ts';

function image(id: string, imageId: string, x: number): SceneElement {
  return {
    id,
    type: 'image',
    version: 2,
    versionNonce: 1,
    updated: 10,
    isDeleted: false,
    x,
    y: 20,
    width: 100,
    height: 80,
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

describe('native scene patches', () => {
  test('adds a labelled region in its image group and keeps the requested bounds', () => {
    const scene = applyPatch(
      [
        {
          op: 'addRegion',
          id: 'region-1',
          imageId: 'image-a',
          groupId: imageGroupId('image-a'),
          rect: { x: 12, y: 24, width: 34, height: 28 },
          label: 'small find',
          properties: { material: 'bone' },
        },
      ],
      [],
    );
    const region = scene.find((el) => el.id === 'region-1');
    expect(region).toMatchObject({
      type: 'rectangle',
      x: 12,
      y: 24,
      width: 34,
      height: 28,
      groupIds: [imageGroupId('image-a')],
      customData: {
        kind: 'region',
        imageId: 'image-a',
        label: 'small find',
        properties: { material: 'bone' },
      },
    });
    const label = scene.find((el) => el.type === 'text');
    expect(label).toBeDefined();
    expect(label?.text).toBe('small find');
    expect(region?.boundElements?.[0]?.type).toBe('text');
    expect(region?.boundElements?.[0]?.id).toBe(label?.id);
  });

  test('adds a bound edge, advances versions on edits, and retains a delete tombstone', () => {
    const seed = [
      image('image-el-a', 'image-a', 0),
      image('image-el-b', 'image-b', 300),
    ];
    const withEdge = applyPatch(
      [
        {
          op: 'addEdge',
          id: 'edge-1',
          fromId: 'image-el-a',
          toId: 'image-el-b',
          fromRect: { x: 0, y: 20, width: 100, height: 80 },
          toRect: { x: 300, y: 20, width: 100, height: 80 },
          relation: 'near',
          direction: 'forward',
          properties: { confidence: 'high' },
        },
      ],
      seed,
    );
    const edge = withEdge.find((el) => el.id === 'edge-1');
    expect(edge?.startBinding?.elementId).toBe('image-el-a');
    expect(edge?.endBinding?.elementId).toBe('image-el-b');
    expect(
      withEdge.find((el) => el.id === 'image-el-a')?.boundElements,
    ).toContainEqual({ id: 'edge-1', type: 'arrow' });

    const moved = applyPatch(
      [{ op: 'update', id: 'edge-1', changes: { x: 80 } }],
      withEdge,
    );
    const movedEdge = moved.find((el) => el.id === 'edge-1');
    expect(movedEdge?.x).toBe(80);
    expect(movedEdge?.version).toBe((edge?.version ?? 0) + 1);

    const deleted = applyPatch([{ op: 'remove', ids: ['edge-1'] }], moved);
    const tombstone = deleted.find((el) => el.id === 'edge-1');
    expect(tombstone?.isDeleted).toBe(true);
    expect(tombstone?.version).toBe((movedEdge?.version ?? 0) + 1);
  });

  test('leaves unrelated elements by identity and missing updates untouched', () => {
    const seed = [
      image('image-el-a', 'image-a', 0),
      image('image-el-b', 'image-b', 300),
    ];
    const changed = applyPatch(
      [{ op: 'update', id: 'image-el-a', changes: { x: 50 } }],
      seed,
    );
    expect(changed[1]).toBe(seed[1]);
    expect(
      applyPatch([{ op: 'update', id: 'missing', changes: { x: 1 } }], seed),
    ).toEqual(seed);
  });
});
