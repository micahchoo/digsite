// copy-foreign.ts: what a copy of another sheet's claim writes, from real
// foreign shapes (overlay/screen.ts#foreignShapes) and image elements keyed
// the way the server keys them, `el-img-<imageId>`.
import { describe, expect, test } from 'bun:test';
import type { Foreign } from '@digsite/shared';
import type {
  NewEdgeOp,
  NewRegionOp,
  SceneElement,
} from '../src/sheet/canvas/types.ts';
import { fullChoice, planCopy } from '../src/sheet/copy-foreign.ts';
import { foreignShapes } from '../src/sheet/overlay/screen.ts';

function picture(imageId: string, x: number): SceneElement {
  return {
    id: `el-img-${imageId}`,
    type: 'image',
    version: 1,
    versionNonce: 1,
    updated: 0,
    isDeleted: false,
    x,
    y: 0,
    width: 200,
    height: 200,
    groupIds: [],
    boundElements: null,
    startBinding: null,
    endBinding: null,
    points: [],
    startArrowhead: null,
    endArrowhead: null,
    customData: { kind: 'image', imageId },
  };
}

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
      label: 'chimney',
      properties: { material: 'brick', year: 1900 },
      sheetName: 'Faces',
    },
  ],
  edges: [
    {
      id: 'other:e1',
      sheetId: 'other',
      sourceId: 'e1',
      source: { imageId: 'img-1' },
      target: { imageId: 'img-2' },
      direction: 'forward',
      relation: 'same place',
      properties: { seen: 'twice', by: 'Ada' },
      confidence: 'likely',
      note: 'same roofline',
      sheetName: 'Faces',
    },
    {
      id: 'other:e2',
      sheetId: 'other',
      sourceId: 'e2',
      source: { imageId: 'img-1', regionSourceId: 'r1' },
      target: { imageId: 'img-2' },
      direction: 'both',
      relation: 'matches',
      properties: {},
      confidence: null,
      note: '',
      sheetName: 'Faces',
    },
  ],
};
const elements = [picture('img-1', 0), picture('img-2', 500)];
const shapes = foreignShapes(rows, elements);
const scene = {
  images: new Map(
    elements.map((el) => [(el.customData as { imageId: string }).imageId, el]),
  ),
  shapes,
};
const shape = (id: string) => {
  const s = shapes.find((x) => x.row.id === id);
  if (!s) throw new Error(`no shape ${id}`);
  return s;
};
let n = 0;
const ids = () => `new-${++n}`;

describe('copying another sheet’s claim', () => {
  test('a connection binds to the pictures’ elements, not their image ids', () => {
    const e1 = shape('other:e1');
    const plan = planCopy(e1, fullChoice(e1), scene, ids);
    if (!plan.ok) throw new Error(plan.reason);
    const edge = plan.ops[0] as NewEdgeOp;
    expect(edge.fromId).toBe('el-img-img-1');
    expect(edge.toId).toBe('el-img-img-2');
    expect(edge).toMatchObject({
      relation: 'same place',
      confidence: 'likely',
      note: 'same roofline',
      properties: { seen: 'twice', by: 'Ada' },
    });
  });

  test('only the chosen parts travel; the shape always does', () => {
    const e1 = shape('other:e1');
    const plan = planCopy(
      e1,
      { label: false, properties: ['seen'], reasons: false, ends: true },
      scene,
      ids,
    );
    if (!plan.ok) throw new Error(plan.reason);
    const edge = plan.ops[0] as NewEdgeOp;
    expect(edge.relation).toBe('');
    expect(edge.properties).toEqual({ seen: 'twice' });
    expect(edge.confidence).toBeUndefined();
    expect(edge.note).toBeUndefined();
  });

  test('a connection from a region brings the region, and joins it', () => {
    const e2 = shape('other:e2');
    const plan = planCopy(e2, fullChoice(e2), scene, ids);
    if (!plan.ok) throw new Error(plan.reason);
    const [region, edge] = plan.ops as [NewRegionOp, NewEdgeOp];
    expect(region).toMatchObject({
      op: 'addRegion',
      imageId: 'img-1',
      label: 'chimney',
      rect: { x: 50, y: 50, width: 100, height: 100 },
    });
    expect(edge.fromId).toBe(region.id);
    expect(edge.toId).toBe('el-img-img-2');
    expect(plan.id).toBe(edge.id);
  });

  test('without its ends, a connection from a region says why it cannot', () => {
    const e2 = shape('other:e2');
    const plan = planCopy(e2, { ...fullChoice(e2), ends: false }, scene, ids);
    expect(plan).toEqual({
      ok: false,
      reason: 'Its start is a region on Faces. Copy it with its ends.',
    });
  });

  test('a region brings its label and the chosen properties', () => {
    const r1 = shape('other:r1');
    const plan = planCopy(
      r1,
      { label: true, properties: ['year'], reasons: false, ends: false },
      scene,
      ids,
    );
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.ops[0]).toMatchObject({
      label: 'chimney',
      properties: { year: 1900 },
    });
  });
});
