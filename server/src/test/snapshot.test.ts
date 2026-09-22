// docs/design.md "Tests": merge by version; project a scene with one image,
// one region, one edge; the rows match; a stale scene cannot roll back.
import { describe, expect, test } from 'bun:test';
import { pool } from '../db/pool.ts';
import {
  getSnapshotElements,
  saveSnapshotAndProject,
} from '../sheets/snapshot.ts';

async function makeBoard(name: string): Promise<string> {
  const { rows } = await pool.query(
    'INSERT INTO boards (org_id, name, open, created_by) VALUES ($1,$2,true,$3) RETURNING id',
    [`org-test-${Date.now()}`, name, 'test-user'],
  );
  return rows[0].id;
}

async function makeSheet(boardId: string, name: string): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO sheets (board_id, name, created_by) VALUES ($1,$2,'tester') RETURNING id`,
    [boardId, name],
  );
  return rows[0].id;
}

async function makeImage(
  boardId: string,
  slot: number,
  name: string,
): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO images (board_id, slot, sha256, name, width, height, uploaded_by)
     VALUES ($1,$2,$3,$4,200,200,'tester') RETURNING id`,
    [boardId, slot, `sha-${slot}-${Date.now()}`, name],
  );
  return rows[0].id;
}

function imageEl(
  id: string,
  imageId: string,
  x: number,
  y: number,
  w: number,
  h: number,
  version = 1,
  versionNonce = 1,
) {
  return {
    id,
    type: 'image',
    x,
    y,
    width: w,
    height: h,
    isDeleted: false,
    version,
    versionNonce,
    customData: { kind: 'image', imageId },
  };
}

function regionEl(
  id: string,
  imageId: string,
  x: number,
  y: number,
  w: number,
  h: number,
  version = 1,
  versionNonce = 1,
) {
  return {
    id,
    type: 'rectangle',
    x,
    y,
    width: w,
    height: h,
    isDeleted: false,
    version,
    versionNonce,
    customData: { kind: 'region', imageId, label: 'find', properties: {} },
  };
}

function edgeEl(
  id: string,
  startId: string,
  endId: string,
  version = 1,
  versionNonce = 1,
) {
  return {
    id,
    type: 'arrow',
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    isDeleted: false,
    version,
    versionNonce,
    startBinding: { elementId: startId },
    endBinding: { elementId: endId },
    customData: {
      kind: 'edge',
      relation: 'resembles',
      direction: 'forward',
      properties: {},
    },
  };
}

describe('snapshot', () => {
  test('projects one image, one region, one edge into matching rows', async () => {
    const boardId = await makeBoard(`snap-test-${Date.now()}`);
    const sheetId = await makeSheet(boardId, 'S1');
    const imgA = await makeImage(boardId, 0, 'a');
    const imgB = await makeImage(boardId, 1, 'b');

    const elements = [
      imageEl('el-img-a', imgA, 0, 0, 200, 200),
      imageEl('el-img-b', imgB, 300, 0, 200, 200),
      regionEl('el-region-1', imgA, 20, 20, 40, 40),
      edgeEl('el-edge-1', 'el-img-a', 'el-img-b'),
    ];

    const r1 = await saveSnapshotAndProject(sheetId, elements);
    expect(r1.unresolved).toBe(0);

    const { rows: regionRows } = await pool.query(
      'SELECT * FROM regions WHERE sheet_id = $1',
      [sheetId],
    );
    expect(regionRows.length).toBe(1);
    expect(regionRows[0].image_id).toBe(imgA);
    expect(regionRows[0].fx).toBeCloseTo(0.1); // (20-0)/200
    expect(regionRows[0].fw).toBeCloseTo(0.2); // 40/200

    const { rows: edgeRows } = await pool.query(
      'SELECT * FROM edges WHERE sheet_id = $1',
      [sheetId],
    );
    expect(edgeRows.length).toBe(1);
    expect(edgeRows[0].src_image_id).toBe(imgA);
    expect(edgeRows[0].dst_image_id).toBe(imgB);
    expect(edgeRows[0].direction).toBe('forward');
    expect(edgeRows[0].relation).toBe('resembles');
  });

  test('a stale (lower-version) write cannot roll back a newer save', async () => {
    const boardId = await makeBoard(`snap-stale-test-${Date.now()}`);
    const sheetId = await makeSheet(boardId, 'S1');
    const imgA = await makeImage(boardId, 0, 'a');

    const fresh = [imageEl('el-img-a', imgA, 0, 0, 200, 200, 1, 1)];
    await saveSnapshotAndProject(sheetId, fresh);

    // a higher version moves the image
    const moved = [imageEl('el-img-a', imgA, 500, 500, 200, 200, 2, 5)];
    await saveSnapshotAndProject(sheetId, moved);

    // a stale write at version 1 (lower than the stored version 2) must not
    // roll the position back
    const stale = [imageEl('el-img-a', imgA, 999, 999, 200, 200, 1, 1)];
    await saveSnapshotAndProject(sheetId, stale);

    const merged = (await getSnapshotElements(sheetId)) as {
      id: string;
      x: number;
    }[];
    const el = merged.find((e) => e.id === 'el-img-a');
    expect(el?.x).toBe(500);
  });
});
