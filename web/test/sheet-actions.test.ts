// sheet/actions.ts: the sheet's multi-step work, run against an in-memory
// scene and a fake server. The room is the fake's `arrive` queue: a picture
// added on the server reaches the scene only after some waits, as it does
// through the socket.
import { describe, expect, test } from 'bun:test';
import type { ClaimReply } from '@digsite/shared';
import {
  type ActionServer,
  createSheetActions,
  imageElementOf,
} from '../src/sheet/actions.ts';
import type { SceneElement } from '../src/sheet/canvas/types.ts';

type Rect = { x: number; y: number; width: number; height: number };

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
const picture = (id: string, imageId: string, rect: Rect) =>
  element({
    id,
    type: 'image',
    customData: { kind: 'image', imageId },
    ...rect,
  });
const region = (id: string, imageId: string, label: string, rect: Rect) =>
  element({
    id,
    customData: { kind: 'region', imageId, label, properties: {} },
    ...rect,
  });

/** A sheet: its elements, what is selected, the tools' two writes, and a
 * server whose added pictures arrive after `arriveAfter` waits. */
function sheet(initial: SceneElement[], opts: { arriveAfter?: number } = {}) {
  const elements = [...initial];
  let selected: string[] = [];
  const arriving: { imageId: string; in: number }[] = [];
  const calls: string[] = [];
  let statuses: string[] = ['ready'];
  let replies: ClaimReply[] = [];

  const scene = {
    elements: () => elements,
    select: (ids: string[]) => {
      selected = ids;
    },
  };
  const tools = {
    moveImage: (imageId: string, dx: number, dy: number) => {
      const el = imageElementOf(elements, imageId);
      if (el) Object.assign(el, { x: el.x + dx, y: el.y + dy });
    },
    connect: (fromId: string, toId: string, relation?: string) => {
      const id = `edge-${elements.length}`;
      elements.push(
        element({
          id,
          type: 'arrow',
          customData: {
            kind: 'edge',
            relation: relation ?? '',
            direction: 'forward',
            properties: {},
          },
          startBinding: { elementId: fromId },
          endBinding: { elementId: toId },
        }),
      );
      return id;
    },
  };
  const server: ActionServer = {
    addSheetImages: async (_board, _sheet, { imageIds }) => {
      for (const imageId of imageIds)
        arriving.push({ imageId, in: opts.arriveAfter ?? 2 });
      calls.push(`add ${imageIds.join(',')}`);
      return { added: imageIds.length } as never;
    },
    extractRegion: async (imageId, body) => {
      calls.push(`extract ${imageId} ${body.label}`);
      return { id: 'cut-1' } as never;
    },
    uploadImageStatuses: async (_board, ids) => {
      const status = statuses.shift() ?? 'ready';
      calls.push(`status ${status}`);
      return { images: ids.map((id) => ({ id, status })) } as never;
    },
    getReplies: async () => ({ replies }),
  };
  // One wait is one tick of the room: arrivals count down and land.
  const wait = async () => {
    for (const a of arriving) a.in--;
    for (const a of arriving.filter((x) => x.in <= 0)) {
      arriving.splice(arriving.indexOf(a), 1);
      elements.push(
        picture(`el-${a.imageId}`, a.imageId, {
          x: 900,
          y: 900,
          width: 100,
          height: 100,
        }),
      );
    }
  };
  const actions = createSheetActions({
    sheetId: 'sheet-1',
    boardId: () => 'board-1',
    scene: () => scene,
    tools,
    server,
    crop: async (imageId, f) =>
      `crop:${imageId}:${f ? f.fw.toFixed(2) : 'whole'}`,
    nameOf: (imageId) => `${imageId}.png`,
    origin: 'https://dig.example',
    changed: () => {},
    wait,
  });
  return {
    actions,
    elements,
    calls,
    selected: () => selected,
    setStatuses: (s: string[]) => {
      statuses = s;
    },
    setReplies: (r: ClaimReply[]) => {
      replies = r;
    },
  };
}

const parent = picture('el-a', 'a', { x: 0, y: 0, width: 200, height: 200 });

describe('bring beside', () => {
  test('waits for the picture to arrive, then puts it on the first free side', async () => {
    const s = sheet([parent]);
    const added = await s.actions.bringBeside('a', 'b');
    expect(added?.id).toBe('el-b');
    // Right of the parent, centred, whatever position it arrived at.
    expect(imageElementOf(s.elements, 'b')).toMatchObject({ x: 248, y: 50 });
  });

  test('a picture that never arrives is null, and nothing moves', async () => {
    const s = sheet([parent], { arriveAfter: 10_000 });
    expect(await s.actions.bringBeside('a', 'b')).toBeNull();
    expect(s.elements).toHaveLength(1);
  });

  test('nothing is asked of the server when the parent is not on the sheet', async () => {
    const s = sheet([]);
    expect(await s.actions.bringBeside('a', 'b')).toBeNull();
    expect(s.calls).toEqual([]);
  });
});

describe('extract', () => {
  const chimney = region('reg-1', 'a', 'chimney', {
    x: 50,
    y: 50,
    width: 100,
    height: 50,
  });

  test('crops, waits until the picture is read, brings it beside and says where it came from', async () => {
    const s = sheet([parent, chimney]);
    s.setStatuses(['pending', 'pending', 'ready']);
    const said: string[] = [];
    await s.actions.extract('reg-1', (step) => said.push(step));
    expect(said).toEqual([
      'Making a picture of "chimney"…',
      'Adding "chimney" to the sheet…',
    ]);
    expect(s.calls).toEqual([
      'extract a chimney',
      'status pending',
      'status pending',
      'status ready',
      'add cut-1',
    ]);
    const edge = s.elements.find((el) => el.customData?.kind === 'edge');
    expect(edge?.customData).toMatchObject({ relation: 'derived from' });
    expect(edge?.startBinding?.elementId).toBe('el-cut-1');
    expect(edge?.endBinding?.elementId).toBe('reg-1');
    expect(s.selected()).toEqual(['el-cut-1']);
  });

  test('a picture the worker cannot read stops with a reason, and adds nothing', async () => {
    const s = sheet([parent, chimney]);
    s.setStatuses(['failed']);
    await expect(s.actions.extract('reg-1', () => {})).rejects.toThrow(
      'the new picture could not be read',
    );
    expect(s.calls).not.toContain('add cut-1');
  });
});

describe('the report', () => {
  test('a connection carries both ends, its replies and a link to itself', async () => {
    const other = picture('el-b', 'b', {
      x: 300,
      y: 0,
      width: 100,
      height: 100,
    });
    const s = sheet([parent, other]);
    const edgeId = s.actions.connectFrom('a', 'el-b', 'same place');
    expect(edgeId).not.toBeNull();
    s.setReplies([
      {
        id: 'r1',
        elementId: edgeId ?? '',
        by: { id: 'u', name: 'Ada' },
        text: 'Sure?',
        at: '2026-09-23T10:00:00Z',
      },
      {
        id: 'r2',
        elementId: 'elsewhere',
        by: { id: 'u', name: 'Ada' },
        text: 'no',
        at: '2026-09-23T10:00:00Z',
      },
    ]);
    const [claim] = await s.actions.reportClaims();
    expect(claim).toMatchObject({
      kind: 'connection',
      term: 'same place',
      link: `https://dig.example/s/sheet-1?claim=${edgeId}`,
      replies: [{ name: 'Ada', text: 'Sure?' }],
    });
    expect(claim?.ends.map((e) => e.name)).toEqual(['a.png', 'b.png']);
    expect(claim?.ends.every((e) => e.crop?.startsWith('crop:'))).toBe(true);
  });

  test('a region is cropped to itself', async () => {
    const s = sheet([
      parent,
      region('reg-1', 'a', 'door', { x: 0, y: 0, width: 50, height: 200 }),
    ]);
    const [claim] = await s.actions.reportClaims();
    expect(claim).toMatchObject({ kind: 'region', term: 'door' });
    expect(claim?.ends[0]?.crop).toBe('crop:a:0.25');
  });
});
