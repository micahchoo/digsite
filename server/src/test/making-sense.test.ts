// CONTEXT.md "Making sense", end to end against the database: an edge's
// confidence and note reach its row; the vocabulary folds aliases; find and
// neighbourhood match a term through its aliases; an alias stays flat; and
// reach finds exactly the edges with one end on a sheet. Fixtures go in by
// SQL and through the real save path, like snapshot.test.ts.
import { describe, expect, test } from 'bun:test';
import { findRanks } from '../boards/find.ts';
import {
  aliasesOf,
  deleteAlias,
  putAlias,
  vocabularyOf,
} from '../boards/vocabulary.ts';
import { pool } from '../db/pool.ts';
import { neighbourhoodFrom } from '../sheets/neighbourhood.ts';
import { reachOf } from '../sheets/reach.ts';
import { saveSnapshotAndProject } from '../sheets/snapshot.ts';

const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function makeBoard(): Promise<string> {
  const { rows } = await pool.query(
    'INSERT INTO boards (org_id, name, open, created_by) VALUES ($1,$2,true,$3) RETURNING id',
    [`org-sense-${uid()}`, 'sense', 'tester'],
  );
  return rows[0].id;
}

async function makeImage(boardId: string, slot: number): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO images (board_id, slot, sha256, name, width, height, uploaded_by)
     VALUES ($1,$2,$3,$4,200,200,'tester') RETURNING id`,
    [boardId, slot, `sha-sense-${uid()}`, `img-${slot}`],
  );
  return rows[0].id;
}

async function makeSheet(boardId: string, imageIds: string[]): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO sheets (board_id, name, created_by) VALUES ($1,$2,'tester') RETURNING id`,
    [boardId, `sheet-${uid()}`],
  );
  const sheetId: string = rows[0].id;
  for (const imageId of imageIds) {
    await pool.query(
      'INSERT INTO sheet_images (sheet_id, image_id) VALUES ($1,$2)',
      [sheetId, imageId],
    );
  }
  return sheetId;
}

const imageEl = (id: string, imageId: string, x: number) => ({
  id,
  type: 'image',
  x,
  y: 0,
  width: 200,
  height: 200,
  isDeleted: false,
  version: 1,
  versionNonce: 1,
  customData: { kind: 'image', imageId },
});

const regionEl = (id: string, imageId: string, x: number, label: string) => ({
  id,
  type: 'rectangle',
  x: x + 20,
  y: 20,
  width: 50,
  height: 50,
  isDeleted: false,
  version: 1,
  versionNonce: 1,
  customData: { kind: 'region', imageId, label, properties: {} },
});

const edgeEl = (
  id: string,
  from: string,
  to: string,
  relation: string,
  extra: Record<string, unknown> = {},
) => ({
  id,
  type: 'arrow',
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  isDeleted: false,
  version: 1,
  versionNonce: 1,
  startBinding: { elementId: from },
  endBinding: { elementId: to },
  customData: {
    kind: 'edge',
    relation,
    direction: 'forward',
    properties: {},
    ...extra,
  },
});

async function makeFixture() {
  const boardId = await makeBoard();
  const [a, b, c, d] = await Promise.all(
    [0, 1, 2, 3].map((slot) => makeImage(boardId, slot)),
  );
  if (!a || !b || !c || !d) throw new Error('fixture: images');
  // S1 holds a, b; S2 holds b, c, d.
  const s1 = await makeSheet(boardId, [a, b]);
  const s2 = await makeSheet(boardId, [b, c, d]);
  await saveSnapshotAndProject(s1, [
    imageEl('ia', a, 0),
    imageEl('ib', b, 300),
    regionEl('ra', a, 0, 'roofline'),
    edgeEl('e1', 'ra', 'ib', 'same place', {
      confidence: 'likely',
      note: 'same chimney',
    }),
  ]);
  await saveSnapshotAndProject(s2, [
    imageEl('ib', b, 0),
    imageEl('ic', c, 300),
    imageEl('id', d, 600),
    regionEl('rc', c, 300, 'roof line'),
    edgeEl('e2', 'ib', 'ic', 'same location'),
    edgeEl('e3', 'ic', 'id', 'derived from'),
  ]);
  return { boardId, a, b, c, d, s1, s2 };
}

describe('making sense', () => {
  test('an edge row carries its confidence and note', async () => {
    const { s1, s2 } = await makeFixture();
    const { rows } = await pool.query(
      'SELECT sheet_id, confidence, note FROM edges WHERE sheet_id = ANY($1::uuid[]) ORDER BY source_id',
      [[s1, s2]],
    );
    expect(rows).toEqual([
      { sheet_id: s1, confidence: 'likely', note: 'same chimney' },
      { sheet_id: s2, confidence: null, note: '' },
      { sheet_id: s2, confidence: null, note: '' },
    ]);
  });

  test('the vocabulary counts terms and folds an alias onto its canonical', async () => {
    const { boardId } = await makeFixture();
    const before = await vocabularyOf(boardId);
    expect(before.relations.map((t) => [t.term, t.count])).toEqual([
      ['derived from', 1],
      ['same location', 1],
      ['same place', 1],
    ]);

    expect(
      await putAlias(
        boardId,
        'relation',
        'same location',
        'same place',
        'tester',
      ),
    ).toBe(true);
    const after = await vocabularyOf(boardId);
    expect(after.relations[0]).toEqual({
      term: 'same place',
      count: 2,
      aliases: ['same location'],
    });
    expect(after.aliases.relation).toEqual({ 'same location': 'same place' });

    await deleteAlias(boardId, 'relation', 'same location');
    expect((await aliasesOf(boardId)).relation).toEqual({});
  });

  test('an alias stays flat when its canonical is merged in turn, and a self-alias is refused', async () => {
    const { boardId } = await makeFixture();
    await putAlias(
      boardId,
      'relation',
      'same location',
      'same place',
      'tester',
    );
    await putAlias(
      boardId,
      'relation',
      'same place',
      'identical place',
      'tester',
    );
    expect((await aliasesOf(boardId)).relation).toEqual({
      'same location': 'identical place',
      'same place': 'identical place',
    });
    expect(
      await putAlias(
        boardId,
        'relation',
        'identical place',
        'same place',
        'tester',
      ),
    ).toBe(false);
  });

  test('find matches a label and a relation through their aliases', async () => {
    const { boardId, a, b, c, d } = await makeFixture();
    const sort = { key: 'name' as const, dir: 'asc' as const };

    const roof = await findRanks(boardId, sort, null, [], {
      label: 'roofline',
    });
    expect(roof.imageIds).toEqual([a]);
    await putAlias(boardId, 'label', 'roof line', 'roofline', 'tester');
    const roofAliased = await findRanks(boardId, sort, null, [], {
      label: 'roofline',
    });
    expect(roofAliased.imageIds.sort()).toEqual([a, c].sort());

    await putAlias(
      boardId,
      'relation',
      'same location',
      'same place',
      'tester',
    );
    const place = await findRanks(boardId, sort, null, [], {
      relation: 'same place',
    });
    expect(place.imageIds.sort()).toEqual([a, b, c].sort());

    const annotated = await findRanks(boardId, sort, null, [], {
      annotated: true,
    });
    expect(annotated.imageIds.sort()).toEqual([a, b, c, d].sort());
  });

  test("reach is every other sheet's edge with exactly one end on this sheet", async () => {
    const { boardId, a, b, c, d, s1, s2 } = await makeFixture();
    // S1 holds a, b. S2's b -> c leaves S1 at b; S2's c -> d never touches S1.
    const fromS1 = await reachOf(s1, boardId);
    expect(fromS1.edges.map((e) => [e.sheetId, e.relation, e.near])).toEqual([
      [s2, 'same location', 'source'],
    ]);
    expect(fromS1.images.map((i) => i.id)).toEqual([c]);
    // S2 holds b, c, d. S1's region-on-a -> b arrives at b from a.
    const fromS2 = await reachOf(s2, boardId);
    expect(fromS2.edges.map((e) => [e.sheetId, e.near, e.note])).toEqual([
      [s1, 'target', 'same chimney'],
    ]);
    expect(fromS2.images.map((i) => i.id)).toEqual([a]);
    expect([b, d]).not.toContain(fromS2.images[0]?.id);
  });

  test('a neighbourhood filtered by relation follows its aliases', async () => {
    const { boardId, a, b, c } = await makeFixture();
    const plain = await neighbourhoodFrom(boardId, a, 3, 'same place');
    expect(plain.images.map((i) => i.id).sort()).toEqual([a, b].sort());
    await putAlias(
      boardId,
      'relation',
      'same location',
      'same place',
      'tester',
    );
    const aliased = await neighbourhoodFrom(boardId, a, 3, 'same place');
    expect(aliased.images.map((i) => i.id).sort()).toEqual([a, b, c].sort());
  });
});
