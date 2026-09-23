// CONTEXT.md "Folder import": a board filled from a folder on the server's
// own disk, so a large library never passes through a browser's file
// chooser (which took seconds just to open on a 20,000-file folder).
//
// The boundary is the operator's: env.IMPORT_ROOTS lists the folders the
// server may read, and none by default. A path is resolved with realpath —
// symlinks and `..` included — and must land inside a root. Every file then
// takes the same path as a browser upload: validateUpload, then uploadOne.
import { createHash } from 'node:crypto';
import { readdir, realpath } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { FolderImport } from '@digsite/shared/api';
import { pool } from '../db/pool.ts';
import { env } from '../env.ts';
import { enqueueJob } from '../worker/jobs.ts';
import { fromCamera, isCameraFile } from './camera.ts';

const IMAGE = /\.(png|jpe?g|webp|gif|avif)$/i;

export class ImportRefused extends Error {
  constructor(
    readonly status: 400 | 403 | 413 | 503,
    message: string,
  ) {
    super(message);
  }
}

/** The real path, if it lies inside an allowed root; else ImportRefused. */
export async function allowedFolder(path: string): Promise<string> {
  if (env.IMPORT_ROOTS.length === 0) {
    throw new ImportRefused(503, 'folder import is off (IMPORT_ROOTS)');
  }
  let real: string;
  try {
    real = await realpath(path);
  } catch {
    throw new ImportRefused(400, 'no such folder');
  }
  for (const root of env.IMPORT_ROOTS) {
    let realRoot: string;
    try {
      realRoot = await realpath(root);
    } catch {
      continue; // a configured root that does not exist allows nothing
    }
    if (real === realRoot || real.startsWith(realRoot + sep)) return real;
  }
  throw new ImportRefused(403, 'folder is outside the allowed roots');
}

/** Image files under `folder`, relative to it, sorted; subfolders
 * included, hidden files and folders skipped. Phone and camera files
 * (camera.ts) are images too. */
export async function listImages(folder: string): Promise<string[]> {
  const entries = await readdir(folder, {
    recursive: true,
    withFileTypes: true,
  });
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!IMAGE.test(entry.name) && !isCameraFile(entry.name)) continue;
    const rel = relative(folder, join(entry.parentPath, entry.name));
    if (rel.split(sep).some((part) => part.startsWith('.'))) continue;
    files.push(rel);
  }
  return files.sort();
}

/** Records the import with its file list and queues its first batch. */
export async function startFolderImport(
  boardId: string,
  userId: string,
  path: string,
): Promise<FolderImport> {
  const folder = await allowedFolder(path);
  const files = await listImages(folder);
  if (files.length > env.IMPORT_MAX_FILES) {
    throw new ImportRefused(
      413,
      `folder holds ${files.length} images; the limit is ${env.IMPORT_MAX_FILES}`,
    );
  }
  const { rows } = await pool.query(
    `INSERT INTO folder_imports (board_id, user_id, path, files, state, finished_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      boardId,
      userId,
      folder,
      files,
      files.length ? 'running' : 'done',
      files.length ? null : new Date(),
    ],
  );
  const id = rows[0].id as string;
  if (files.length) await enqueueJob('folder-import', { importId: id });
  return {
    id,
    path: folder,
    total: files.length,
    imported: 0,
    skipped: 0,
    skips: [],
    state: files.length ? 'running' : 'done',
  };
}

export async function folderImport(
  boardId: string,
  importId: string,
): Promise<FolderImport | null> {
  const { rows } = await pool.query(
    `SELECT id, path, cardinality(files) AS total, imported, skipped, skips, state
     FROM folder_imports WHERE board_id = $1 AND id::text = $2`,
    [boardId, importId],
  );
  return (rows[0] as FolderImport | undefined) ?? null;
}

const BATCH = 200; // files per job: one lease, then the next job
const SKIPS_KEPT = 20;

/** One batch of an import: the next BATCH files, each validated and
 * uploaded exactly as a browser upload is; then the next batch is queued,
 * or the import is done. The cursor moves after every file. */
export async function runFolderImportBatch(importId: string): Promise<void> {
  const { rows } = await pool.query(
    `SELECT board_id, user_id, path, files[next + 1 : next + $2] AS batch
     FROM folder_imports WHERE id = $1 AND state = 'running'`,
    [importId, BATCH],
  );
  const job = rows[0];
  if (!job) return; // finished, or its board was deleted
  const { validateUpload } = await import('./validate.ts');
  const { uploadOne } = await import('./upload.ts');
  for (const file of job.batch as string[]) {
    const admitted = await admit(job.board_id, job.path, file, validateUpload);
    const skip = 'skip' in admitted ? admitted.skip : null;
    if (!('skip' in admitted)) {
      // Not caught: a failure here is the server's (storage, database, a
      // full disk), never this file's. The job retries with the cursor
      // unmoved, and the import resumes on this file. Before, a missing
      // DATA_DIR skipped every file of a 901-file import as its own fault.
      await uploadOne(
        job.board_id,
        job.user_id,
        admitted.name,
        admitted.bytes,
        admitted.properties,
      );
    }
    await pool.query(
      `UPDATE folder_imports SET next = next + 1,
         imported = imported + $2, skipped = skipped + $3,
         skips = CASE WHEN $4::jsonb IS NOT NULL AND jsonb_array_length(skips) < $5
                 THEN skips || $4::jsonb ELSE skips END
       WHERE id = $1`,
      [
        importId,
        skip ? 0 : 1,
        skip ? 1 : 0,
        skip ? JSON.stringify([{ file, reason: skip }]) : null,
        SKIPS_KEPT,
      ],
    );
  }
  const { rows: after } = await pool.query(
    `UPDATE folder_imports SET
       state = CASE WHEN next >= cardinality(files) THEN 'done' ELSE state END,
       finished_at = CASE WHEN next >= cardinality(files) THEN now() END
     WHERE id = $1 RETURNING state`,
    [importId],
  );
  if (after[0]?.state === 'running') {
    await enqueueJob('folder-import', { importId });
  }
}

type Admitted =
  | { name: string; bytes: Uint8Array; properties: Record<string, unknown> }
  | { skip: string };

/** One file as an upload, or why it is skipped. Only the FILE's faults
 * are skips: it vanished, cannot be read, is not an image, or its bytes
 * are already an image on this board (C6: a folder imported twice made
 * every image twice). */
async function admit(
  boardId: string,
  folder: string,
  file: string,
  validateUpload: typeof import('./validate.ts').validateUpload,
): Promise<Admitted> {
  const name = file.slice(file.lastIndexOf(sep) + 1);
  const dir = file.includes(sep) ? file.slice(0, file.lastIndexOf(sep)) : '';
  const properties: Record<string, unknown> = dir ? { folder: dir } : {};
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await Bun.file(join(folder, file)).arrayBuffer());
  } catch (error) {
    // The folder is the owner's and may change under the import.
    return { skip: error instanceof Error ? error.message : String(error) };
  }
  // A phone or camera file becomes a JPEG here and is an ordinary image
  // from then on; `format` keeps what it was.
  if (isCameraFile(name)) {
    const converted = await fromCamera(name, bytes);
    if (!converted.ok) return { skip: converted.reason };
    bytes = converted.bytes;
    properties.format = converted.format;
  }
  const result = validateUpload(bytes);
  if (!result.ok) return { skip: result.reason };
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const { rows } = await pool.query(
    'SELECT name FROM images WHERE board_id = $1 AND sha256 = $2 LIMIT 1',
    [boardId, sha256],
  );
  if (rows[0]) return { skip: `already on this board as ${rows[0].name}` };
  return { name, bytes, properties };
}
