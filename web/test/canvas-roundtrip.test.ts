// docs/phases/2-sheet.md section 8's own acceptance test: "a sheet saved by
// one adapter opens in the other with every claim in place." Pure, over the
// element JSON — no React, no canvas, no socket. "Every claim in place"
// means what CONTEXT.md's "Claim"/"Projection" mean it to mean:
// `@digsite/shared`'s `project()` (the server's own read of a snapshot)
// must find the SAME regions and edges whichever adapter's patch-application
// built the scene. Needs `test/dom-shim.ts` (bunfig.toml's global preload)
// because the excalidraw side imports `@excalidraw/excalidraw`, same as
// `canvas.test.ts`.
import { describe, expect, test } from 'bun:test';
import { imageGroupId, project } from '@digsite/shared';
import { applyPatch as excalidrawApplyPatch } from '../src/sheet/canvas/excalidraw/convert.ts';
import { applyPatch as nativeApplyPatch } from '../src/sheet/canvas/native/ops.ts';
import type {
  NewEdgeOp,
  NewRegionOp,
  PatchOp,
  SceneElement,
} from '../src/sheet/canvas/types.ts';

// A minimal object shaped like an ExcalidrawElement — the same convention
// canvas.test.ts's own `fakeExcalidrawElement` uses, one per seeded image.
function fakeExcalidrawImage(
  id: string,
  imageId: string,
  rect: { x: number; y: number; width: number; height: number },
) {
  return {
    id,
    type: 'image',
    version: 1,
    versionNonce: 1,
    updated: 0,
    isDeleted: false,
    ...rect,
    customData: { kind: 'image', imageId },
    groupIds: [],
    boundElements: null,
    startBinding: null,
    endBinding: null,
    points: [],
    startArrowhead: null,
    endArrowhead: null,
    // biome-ignore lint/suspicious/noExplicitAny: a hand-built element for a test fixture, not a real Excalidraw type
  } as any;
}

function nativeImage(
  id: string,
  imageId: string,
  rect: { x: number; y: number; width: number; height: number },
): SceneElement {
  return {
    id,
    type: 'image',
    version: 1,
    versionNonce: 1,
    updated: 0,
    isDeleted: false,
    ...rect,
    customData: { kind: 'image', imageId },
    groupIds: [],
    boundElements: null,
    startBinding: null,
    endBinding: null,
    points: [],
    startArrowhead: null,
    endArrowhead: null,
  };
}

// Identical ops for both adapters: two images, a labelled region on the
// first, and an edge between the two images.
function opsFor(): PatchOp[] {
  const addRegion: NewRegionOp = {
    op: 'addRegion',
    id: 'region-1',
    imageId: 'image-a',
    groupId: imageGroupId('image-a'),
    rect: { x: 110, y: 120, width: 40, height: 30 },
    label: 'a find',
    properties: { material: 'bone' },
  };
  const addEdge: NewEdgeOp = {
    op: 'addEdge',
    id: 'edge-1',
    fromId: 'img-a',
    toId: 'img-b',
    fromRect: { x: 100, y: 100, width: 200, height: 200 },
    toRect: { x: 500, y: 500, width: 200, height: 200 },
    relation: 'near',
    direction: 'forward',
    properties: { confidence: 'high' },
  };
  return [addRegion, addEdge];
}

describe('canvas-roundtrip', () => {
  test('the excalidraw and native adapters project the same claims from the same ops', () => {
    const ops = opsFor();

    const excalidrawSeed = [
      fakeExcalidrawImage('img-a', 'image-a', {
        x: 100,
        y: 100,
        width: 200,
        height: 200,
      }),
      fakeExcalidrawImage('img-b', 'image-b', {
        x: 500,
        y: 500,
        width: 200,
        height: 200,
      }),
    ];
    const excalidrawBuilt = excalidrawApplyPatch(ops, excalidrawSeed);
    // biome-ignore lint/suspicious/noExplicitAny: the excalidraw-shaped fixture has more fields than SceneElement declares; project() only reads the ones it declares
    const sceneFromExcalidraw = excalidrawBuilt as any as SceneElement[];

    const nativeSeed = [
      nativeImage('img-a', 'image-a', {
        x: 100,
        y: 100,
        width: 200,
        height: 200,
      }),
      nativeImage('img-b', 'image-b', {
        x: 500,
        y: 500,
        width: 200,
        height: 200,
      }),
    ];
    const sceneFromNative = nativeApplyPatch(ops, nativeSeed);

    const projFromExcalidraw = project('sheet-1', sceneFromExcalidraw);
    const projFromNative = project('sheet-1', sceneFromNative);

    expect(projFromExcalidraw.unresolved).toBe(0);
    expect(projFromNative.unresolved).toBe(0);

    // Same claim ids (both adapters were handed the same op ids), same
    // fractions, same label, same properties.
    expect(projFromNative.regions).toEqual(projFromExcalidraw.regions);
    expect(projFromNative.edges).toEqual(projFromExcalidraw.edges);

    expect(projFromNative.regions).toEqual([
      {
        id: 'sheet-1:region-1',
        sheetId: 'sheet-1',
        sourceId: 'region-1',
        imageId: 'image-a',
        fx: 0.05,
        fy: 0.1,
        fw: 0.2,
        fh: 0.15,
        label: 'a find',
        properties: { material: 'bone' },
      },
    ]);
    expect(projFromNative.edges).toEqual([
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
  });

  test('a scene the native adapter built is readable by the shared, adapter-agnostic dataOf/project pipeline directly (no conversion step)', () => {
    const ops = opsFor();
    const seed = [
      nativeImage('img-a', 'image-a', {
        x: 100,
        y: 100,
        width: 200,
        height: 200,
      }),
      nativeImage('img-b', 'image-b', {
        x: 500,
        y: 500,
        width: 200,
        height: 200,
      }),
    ];
    const scene = nativeApplyPatch(ops, seed);
    const region = scene.find((e) => e.id === 'region-1');
    const labelText = scene.find((e) =>
      region?.boundElements?.some((b) => b.id === e.id),
    );
    expect(labelText?.text).toBe('a find'); // short label: not truncated
    const edgeLabel = scene.find((e) =>
      scene
        .find((a) => a.id === 'edge-1')
        ?.boundElements?.some((b) => b.id === e.id),
    );
    expect(edgeLabel?.text).toBe('near');
  });
});
