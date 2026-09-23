import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// boards/folder-import.ts: a board filled from a folder on the server's
// disk. The roots are the boundary; every file goes the upload path.
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  ImportRefused,
  allowedFolder,
  folderImport,
  startFolderImport,
} from '../boards/folder-import.ts';
import { pool } from '../db/pool.ts';
import { env } from '../env.ts';
import { drain } from '../worker/index.ts';

let root = '';
let outside = '';

function png(hue: number) {
  return sharp({
    create: {
      width: 16,
      height: 16,
      channels: 3,
      background: { r: hue, g: 80, b: 40 },
    },
  })
    .png()
    .toBuffer();
}

async function refusal(path: string): Promise<number | null> {
  try {
    await allowedFolder(path);
    return null;
  } catch (err) {
    return err instanceof ImportRefused ? err.status : -1;
  }
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'import-root-'));
  outside = await mkdtemp(join(tmpdir(), 'import-outside-'));
  await writeFile(join(root, 'a.png'), await png(10));
  await writeFile(join(root, 'b.png'), await png(90));
  await writeFile(join(root, 'fake.png'), 'not an image');
  await writeFile(join(root, 'notes.txt'), 'ignored');
  await mkdir(join(root, 'trip'));
  await writeFile(join(root, 'trip', 'c.png'), await png(170));
  await mkdir(join(root, '.cache'));
  await writeFile(join(root, '.cache', 'd.png'), await png(250));
  await symlink(outside, join(root, 'escape'));
});

afterAll(async () => {
  env.IMPORT_ROOTS = [];
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe('folder import', () => {
  test('off without roots; refused outside them, however it is spelled', async () => {
    env.IMPORT_ROOTS = [];
    expect(await refusal(root)).toBe(503);
    env.IMPORT_ROOTS = [root];
    expect(await refusal(root)).toBeNull();
    expect(await refusal(join(root, 'trip'))).toBeNull();
    expect(await refusal(outside)).toBe(403);
    expect(await refusal(join(root, '..', 'x'))).toBe(400);
    expect(await refusal(join(root, 'escape'))).toBe(403);
    expect(await refusal(`${root}-sibling`)).toBe(400);
  });

  test('imports the images, skips what is not one, and remembers the subfolder', async () => {
    env.IMPORT_ROOTS = [root];
    const { rows } = await pool.query(
      `INSERT INTO boards (org_id, name, open, created_by)
       VALUES ('org-import', $1, true, 'importer') RETURNING id`,
      [`folder-${Date.now()}`],
    );
    const boardId = rows[0].id as string;
    const started = await startFolderImport(boardId, 'importer', root);
    expect(started.total).toBe(4); // a, b, fake, trip/c — never .cache
    await drain();

    const done = await folderImport(boardId, started.id);
    expect(done).toMatchObject({ state: 'done', imported: 3, skipped: 1 });
    expect(done?.skips[0]?.file).toBe('fake.png');

    const { rows: images } = await pool.query(
      'SELECT name, status, properties FROM images WHERE board_id = $1 ORDER BY name',
      [boardId],
    );
    expect(images.map((i) => i.name)).toEqual(['a.png', 'b.png', 'c.png']);
    expect(images.every((i) => i.status === 'ready')).toBe(true);
    expect(images[2]?.properties.folder).toBe('trip');
  });
});
