import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// boards/folder-import.ts: a board filled from a folder on the server's
// disk. The roots are the boundary; every file goes the upload path.
import {
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  ImportRefused,
  allowedFolder,
  folderImport,
  runFolderImportBatch,
  startFolderImport,
} from '../boards/folder-import.ts';
import { pool } from '../db/pool.ts';
import { env } from '../env.ts';
import { resetRoomForTest } from '../storage/room.ts';
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
  await mkdir(join(root, 'trip'));
  await writeFile(join(root, 'notes.txt'), 'ignored');
  // A real phone photo imports; a "RAW" that is not one is explained.
  await copyFile(
    join(import.meta.dir, 'fixtures', 'split-64x48.heic'),
    join(root, 'IMG_0001.HEIC'),
  );
  await writeFile(join(root, 'trip', 'DSC_0002.nef'), 'raw');
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

  test('imports the images, explains every skip, and remembers the subfolder', async () => {
    env.IMPORT_ROOTS = [root];
    const { rows } = await pool.query(
      `INSERT INTO boards (org_id, name, open, created_by)
       VALUES ('org-import', $1, true, 'importer') RETURNING id`,
      [`folder-${Date.now()}`],
    );
    const boardId = rows[0].id as string;
    const started = await startFolderImport(boardId, 'importer', root);
    // a, b, fake, the HEIC, trip/c, trip's NEF — never .cache or notes.txt
    expect(started.total).toBe(6);
    await drain();

    const done = await folderImport(boardId, started.id);
    expect(done).toMatchObject({ state: 'done', imported: 4, skipped: 2 });
    const why = Object.fromEntries(
      (done?.skips ?? []).map((s) => [s.file, s.reason]),
    );
    expect(why['fake.png']).toBe('not a recognised image type');
    expect(why[join('trip', 'DSC_0002.nef')]).toBe(
      'NEF carries no full-size JPEG',
    );

    const { rows: images } = await pool.query(
      'SELECT name, status, properties FROM images WHERE board_id = $1 ORDER BY name',
      [boardId],
    );
    const byName = new Map(images.map((i) => [i.name as string, i]));
    expect([...byName.keys()].sort()).toEqual([
      'IMG_0001.HEIC',
      'a.png',
      'b.png',
      'c.png',
    ]);
    expect(images.every((i) => i.status === 'ready')).toBe(true);
    expect(byName.get('c.png')?.properties.folder).toBe('trip');
    expect(byName.get('IMG_0001.HEIC')?.properties.format).toBe('HEIC');
  });

  test('a server fault skips nothing: the batch fails, and the import resumes on the same file', async () => {
    env.IMPORT_ROOTS = [root];
    const { rows } = await pool.query(
      `INSERT INTO boards (org_id, name, open, created_by)
       VALUES ('org-import', $1, true, 'importer') RETURNING id`,
      [`folder-fault-${Date.now()}`],
    );
    const boardId = rows[0].id as string;
    const started = await startFolderImport(boardId, 'importer', root);
    // The fault seen for real: statfs on a DATA_DIR that is not there.
    // Not StorageFull, which was already passed through.
    const { DATA_DIR, UPLOAD_MIN_FREE_GB } = env;
    env.DATA_DIR = join(outside, 'no-such-data-dir');
    env.UPLOAD_MIN_FREE_GB = 1;
    resetRoomForTest();
    try {
      await expect(runFolderImportBatch(started.id)).rejects.toThrow('ENOENT');
    } finally {
      Object.assign(env, { DATA_DIR, UPLOAD_MIN_FREE_GB });
      resetRoomForTest();
    }
    expect(await folderImport(boardId, started.id)).toMatchObject({
      state: 'running',
      imported: 0,
      skipped: 0,
    });
    await drain();
    expect(await folderImport(boardId, started.id)).toMatchObject({
      state: 'done',
      imported: 4,
      skipped: 2,
    });
  });

  test('a folder imported twice adds nothing the second time, and says where each file already is', async () => {
    env.IMPORT_ROOTS = [root];
    const { rows } = await pool.query(
      `INSERT INTO boards (org_id, name, open, created_by)
       VALUES ('org-import', $1, true, 'importer') RETURNING id`,
      [`folder-twice-${Date.now()}`],
    );
    const boardId = rows[0].id as string;
    const first = await startFolderImport(boardId, 'importer', root);
    await drain();
    expect(await folderImport(boardId, first.id)).toMatchObject({
      imported: 4,
    });
    const again = await startFolderImport(boardId, 'importer', root);
    await drain();
    const done = await folderImport(boardId, again.id);
    expect(done).toMatchObject({ state: 'done', imported: 0, skipped: 6 });
    const why = Object.fromEntries(
      (done?.skips ?? []).map((s) => [s.file, s.reason]),
    );
    expect(why['a.png']).toBe('already on this board as a.png');
    expect(why['IMG_0001.HEIC']).toBe('already on this board as IMG_0001.HEIC');
    const { rows: count } = await pool.query(
      'SELECT count(*)::int AS n FROM images WHERE board_id = $1',
      [boardId],
    );
    expect(count[0].n).toBe(4);
  });
});
