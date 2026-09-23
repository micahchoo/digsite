import { beforeEach, describe, expect, test } from 'bun:test';
// meaning/labels.ts: the board's own label terms, canonical after aliases,
// scored against an image's embedding. The text embedder is a fake, so no
// CLIP download: each prompt maps to a fixed direction.
import { putAlias } from '../boards/vocabulary.ts';
import { pool } from '../db/pool.ts';
import {
  PROMPT,
  resetLabelCacheForTest,
  suggestLabels,
} from '../meaning/labels.ts';
import { MODEL, toVectorText } from '../meaning/model.ts';

function unitVector(values: number[]): Float32Array {
  const out = new Float32Array(512);
  out.set(values);
  const norm = Math.hypot(...values) || 1;
  return out.map((v) => v / norm);
}

const DIRECTIONS: Record<string, number[]> = {
  pottery: [1, 0, 0],
  inscription: [0, 1, 0],
  doorway: [0, 0, 1],
};

const calls: string[] = [];
async function fakeEmbed(text: string): Promise<Float32Array> {
  calls.push(text);
  const term = Object.keys(DIRECTIONS).find((t) => text === PROMPT(t));
  return unitVector(term ? (DIRECTIONS[term] as number[]) : [0, 0, 0, 1]);
}

/** A board with one image embedded along `image`, and one sheet whose
 * regions carry `labels`. */
async function boardWith(image: number[] | null, labels: string[]) {
  const stamp = `${Date.now()}-${Math.random()}`;
  const { rows } = await pool.query(
    `INSERT INTO boards (org_id, name, open, created_by, image_count)
     VALUES ($1, $2, true, 'tester', 1) RETURNING id`,
    [`org-labels-${stamp}`, `labels-${stamp}`],
  );
  const boardId = rows[0].id as string;
  const { rows: img } = await pool.query(
    `INSERT INTO images (board_id, slot, sha256, name, width, height, uploaded_by, properties)
     VALUES ($1, 0, $2, 'a.png', 10, 10, 'tester', '{}') RETURNING id`,
    [boardId, `sha-${stamp}`],
  );
  const imageId = img[0].id as string;
  if (image) {
    await pool.query(
      `INSERT INTO image_embeddings (image_id, model, board_id, slot, embedding)
       VALUES ($1, $2, $3, 0, $4::halfvec)`,
      [imageId, MODEL, boardId, toVectorText(unitVector(image))],
    );
  }
  const { rows: sheet } = await pool.query(
    `INSERT INTO sheets (board_id, name, created_by) VALUES ($1, 'S', 'tester') RETURNING id`,
    [boardId],
  );
  for (const [i, label] of labels.entries()) {
    await pool.query(
      `INSERT INTO regions (id, sheet_id, source_id, image_id, fx, fy, fw, fh, label)
       VALUES ($1, $2, $1, $3, 0, 0, 0.5, 0.5, $4)`,
      [`r${i}-${stamp}`, sheet[0].id, imageId, label],
    );
  }
  return { boardId, imageId };
}

beforeEach(() => {
  resetLabelCacheForTest();
  calls.length = 0;
});

describe('label suggestions', () => {
  test("the board's own terms, best first; an alias counts as its canonical term", async () => {
    const { boardId, imageId } = await boardWith(
      [0.2, 1, 0],
      ['pottery', 'inscription', 'doorway', 'writing'],
    );
    await putAlias(boardId, 'label', 'writing', 'inscription', 'tester');
    const got = await suggestLabels(boardId, imageId, 2, fakeEmbed);
    expect(got?.map((s) => s.term)).toEqual(['inscription', 'pottery']);
    expect(got?.[0]?.score).toBeGreaterThan(got?.[1]?.score ?? 1);
    // 'writing' is never offered, and never embedded.
    expect(calls).not.toContain(PROMPT('writing'));
  });

  test('a term is embedded once per process', async () => {
    const { boardId, imageId } = await boardWith([1, 0, 0], ['pottery']);
    await suggestLabels(boardId, imageId, 5, fakeEmbed);
    await suggestLabels(boardId, imageId, 5, fakeEmbed);
    expect(calls).toEqual([PROMPT('pottery')]);
  });

  test('null without an embedding; empty on a board with no labels', async () => {
    const bare = await boardWith(null, ['pottery']);
    expect(await suggestLabels(bare.boardId, bare.imageId, 5, fakeEmbed)).toBe(
      null,
    );
    const unlabelled = await boardWith([1, 0, 0], []);
    expect(
      await suggestLabels(unlabelled.boardId, unlabelled.imageId, 5, fakeEmbed),
    ).toEqual([]);
  });
});
