// reports/gather.ts: a report reads claims the way every reader does —
// from the rows a snapshot projects, canonical after aliases, stamps and
// the dangling mark from the scene — for each scope a report can name.
import { beforeAll, describe, expect, test } from 'bun:test';
import type { ReportClaim, ReportData } from '@digsite/shared';
import { pool } from '../db/pool.ts';
import { gatherReport } from '../reports/gather.ts';
import { saveSnapshotAndProject } from '../sheets/snapshot.ts';

let boardId = '';
let slot = 0;

async function image(name: string, missing = false) {
  slot += 1;
  const { rows } = await pool.query(
    `INSERT INTO images (board_id, slot, sha256, name, width, height, uploaded_by, missing, properties)
     VALUES ($1, $2, $3, $4, 400, 200, 'tester', $5, $6) RETURNING id`,
    [
      boardId,
      slot,
      `sha-report-${slot}-${Math.random()}`,
      name,
      missing,
      JSON.stringify({ camera: 'Nikon D850' }),
    ],
  );
  return rows[0].id as string;
}

async function sheet(name: string, imageIds: string[]) {
  const { rows } = await pool.query(
    `INSERT INTO sheets (board_id, name, created_by) VALUES ($1, $2, 'tester') RETURNING id`,
    [boardId, name],
  );
  const id = rows[0].id as string;
  for (const img of imageIds)
    await pool.query(
      'INSERT INTO sheet_images (sheet_id, image_id) VALUES ($1, $2)',
      [id, img],
    );
  return id;
}

let v = 0;
const base = (id: string, x: number, y: number, w: number, h: number) => ({
  id,
  version: ++v,
  versionNonce: v,
  type: 'rectangle',
  isDeleted: false,
  x,
  y,
  width: w,
  height: h,
  groupIds: [],
  boundElements: null,
  updated: Date.now(),
});
const pic = (id: string, imageId: string, x: number, y: number) => ({
  ...base(id, x, y, 400, 200),
  type: 'image',
  customData: { kind: 'image', imageId },
});
const box = (
  id: string,
  imageId: string,
  label: string,
  x: number,
  y: number,
) => ({
  ...base(id, x, y, 100, 50),
  customData: {
    kind: 'region',
    imageId,
    label,
    properties: {},
    made: { id: 'u1', name: 'Ada', at: '2026-09-20T10:00:00.000Z' },
  },
});
const line = (
  id: string,
  from: string,
  to: string,
  relation: string,
  extra: Record<string, unknown> = {},
) => ({
  ...base(id, 0, 0, 1, 1),
  type: 'arrow',
  points: [
    [0, 0],
    [1, 1],
  ],
  startBinding: { elementId: from },
  endBinding: { elementId: to },
  startArrowhead: null,
  endArrowhead: 'arrow',
  customData: {
    kind: 'edge',
    relation,
    direction: 'forward',
    properties: {},
    confidence: 'likely',
    note: 'same chimney line',
    ...extra,
  },
});

const claim = (r: ReportData, elementId: string) =>
  r.claims.find((c) => c.elementId === elementId) as ReportClaim;

let a = '';
let b = '';
let c = '';
let gone = '';
let first = '';
let second = '';

beforeAll(async () => {
  const { rows } = await pool.query(
    `INSERT INTO boards (org_id, name, open, created_by)
     VALUES ($1, 'Chimneys', true, 'tester') RETURNING id`,
    [`org-report-${Date.now()}-${Math.random()}`],
  );
  boardId = rows[0].id;
  // Named so slot order and reading order differ: c sits top-left.
  a = await image('a.jpg');
  b = await image('b.jpg');
  c = await image('c.jpg');
  gone = await image('gone.jpg', true);
  await pool.query(
    `INSERT INTO term_aliases (board_id, kind, term, canonical, created_by)
     VALUES ($1, 'relation', 'same location', 'same place', 'tester'),
            ($1, 'label', 'stack', 'chimney', 'tester')`,
    [boardId],
  );

  first = await sheet('First pass', [a, b, c, gone]);
  await saveSnapshotAndProject(first, [
    pic('pa', a, 500, 0),
    pic('pb', b, 0, 400),
    pic('pc', c, 0, 0),
    pic('pg', gone, 500, 400),
    box('ra', a, 'stack', 600, 50),
    line('e1', 'ra', 'pb', 'same location'),
    line('e2', 'pb', 'pc', 'copy of', { dangling: true }),
    line('e3', 'pc', 'pg', 'resembles'),
  ]);
  await pool.query(
    `INSERT INTO claim_replies (board_id, sheet_id, element_id, user_id, body)
     VALUES ($1, $2, 'e1', 'tester', 'Checked on site.')`,
    [boardId, first],
  );

  second = await sheet('Second look', [a, b]);
  await saveSnapshotAndProject(second, [
    pic('qa', a, 0, 0),
    pic('qb', b, 500, 0),
    line('f1', 'qa', 'qb', 'painted over'),
  ]);
  await sheet('Empty', [a]);
});

const gather = (scope: ReportData['scope']) =>
  gatherReport({
    scope,
    boardId,
    boardName: 'Chimneys',
    by: 'Ada',
    origin: 'https://dig.example',
  });

describe('a sheet report', () => {
  test('reads canonical terms, keeps what was typed, and rests edges on their regions', async () => {
    const r = await gather({ kind: 'sheet', sheetId: first });
    expect(r.title).toBe('First pass');
    const e1 = claim(r, 'e1');
    expect(e1.term).toBe('same place');
    expect(e1.typed).toBe('same location');
    expect(e1.confidence).toBe('likely');
    expect(e1.note).toBe('same chimney line');
    expect(e1.ends[0]).toEqual({
      imageId: a,
      regionKey: `${first}:ra`,
      label: 'chimney',
      fraction: { fx: 0.25, fy: 0.25, fw: 0.25, fh: 0.25 },
    });
    expect(e1.ends[1]?.fraction).toBeNull();
    expect(e1.replies.map((x) => x.text)).toEqual(['Checked on site.']);
    const ra = claim(r, 'ra');
    expect(ra.term).toBe('chimney');
    expect(ra.typed).toBe('stack');
    expect(ra.made?.name).toBe('Ada');
  });

  test('says what dangles, and why', async () => {
    const r = await gather({ kind: 'sheet', sheetId: first });
    expect(claim(r, 'e2').dangling).toContain('region it joined was deleted');
    expect(claim(r, 'e3').dangling).toContain('removed from the board');
    expect(claim(r, 'e1').dangling).toBeNull();
    expect(r.images.find((i) => i.id === gone)?.missing).toBe(true);
  });

  test('lists pictures in the reading order of the sheet, with their properties', async () => {
    const r = await gather({ kind: 'sheet', sheetId: first });
    expect(r.images.map((i) => i.name)).toEqual([
      'c.jpg',
      'a.jpg',
      'b.jpg',
      'gone.jpg',
    ]);
    expect(r.images[0]?.properties.camera).toBe('Nikon D850');
    expect(r.scene?.sheetId).toBe(first);
    expect(r.scene?.elements.length).toBe(8);
    expect(r.sheets.map((s) => s.name)).toEqual(['First pass']);
    expect(r.sheets[0]?.savedAt).not.toBeNull();
  });

  test('a selection of one picture brings its regions and nothing that leaves it', async () => {
    const r = await gather({ kind: 'selection', sheetId: first, ids: ['pa'] });
    expect(r.claims.map((x) => x.elementId)).toEqual(['ra']);
    const both = await gather({
      kind: 'selection',
      sheetId: first,
      ids: ['pb', 'pc', 'e1'],
    });
    expect(both.claims.map((x) => x.elementId).sort()).toEqual(['e1', 'e2']);
  });
});

describe('a board report', () => {
  test('is the union, and names only the sheets that speak', async () => {
    const r = await gather({ kind: 'board', boardId });
    expect(r.claims.map((x) => x.elementId).sort()).toEqual([
      'e1',
      'e2',
      'e3',
      'f1',
      'ra',
    ]);
    expect(r.sheets.map((s) => s.name).sort()).toEqual([
      'First pass',
      'Second look',
    ]);
    expect(r.scene).toBeNull();
    expect(claim(r, 'f1').sheetId).toBe(second);
  });

  test('a relation report matches every spelling of the relation', async () => {
    const r = await gather({
      kind: 'relation',
      boardId,
      relation: 'same location',
    });
    expect(r.claims.map((x) => x.elementId)).toEqual(['e1']);
    expect(r.title).toBe('“same location” on Chimneys');
  });

  test('a path report carries every claim on each step', async () => {
    const r = await gather({ kind: 'path', boardId, from: a, to: c });
    expect(r.path).toEqual([a, b, c]);
    expect(r.claims.map((x) => x.elementId).sort()).toEqual(['e1', 'e2', 'f1']);
    const none = await gather({ kind: 'path', boardId, from: a, to: a });
    expect(none.path).toEqual([a]);
  });
});
