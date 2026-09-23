// CONTEXT.md "Folder import": a board filled from a folder on the server's
// own disk, so a large library never passes through a browser's file
// chooser (which took seconds just to open on a 20,000-file folder).
//
// The boundary is the operator's: env.IMPORT_ROOTS lists the folders the
// server may read, and none by default. A path is resolved with realpath —
// symlinks and `..` included — and must land inside a root. Every file then
// takes the same path as a browser upload: validateUpload, then uploadOne.
import { readdir, realpath } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { FolderImport } from '@digsite/shared/api';
import { pool } from '../db/pool.ts';
import { env } from '../env.ts';
import { StorageFull } from '../storage/room.ts';
import { enqueueJob } from '../worker/jobs.ts';

const IMAGE = /\.(png|jpe?g|webp|gif|avif)$/i;
// Phone and camera formats (roadmap item 8). They are listed so that each
// is counted and explained as a skip, never dropped without a word: before
// this, a phone folder of HEIC files imported as "0 of 0". They are
// skipped by name, without reading a 50 MB RAW file to refuse it.
const CAMERA =
  /\.(heic|heif|dng|nef|nrw|cr2|cr3|crw|arw|srf|sr2|raf|orf|rw2|pef|srw|x3f|3fr|iiq|erf|kdc|dcr|mrw|raw|rwl)$/i;
const CAMERA_SKIP = 'phone or camera format (HEIC or RAW); not decoded yet';

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
 * included, hidden files and folders skipped. Camera formats are listed
 * too, so the batch can say why each is skipped. */
export async function listImages(folder: string): Promise<string[]> {
  const entries = await readdir(folder, {
    recursive: true,
    withFileTypes: true,
  });
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!IMAGE.test(entry.name) && !CAMERA.test(entry.name)) continue;
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
    let skip: string | null = null;
    if (CAMERA.test(file)) {
      skip = CAMERA_SKIP;
    } else {
      try {
        const bytes = new Uint8Array(
          await Bun.file(join(job.path, file)).arrayBuffer(),
        );
        const result = validateUpload(bytes);
        if (result.ok) {
          const dir = file.includes(sep)
            ? file.slice(0, file.lastIndexOf(sep))
            : '';
          await uploadOne(
            job.board_id,
            job.user_id,
            file.slice(file.lastIndexOf(sep) + 1),
            bytes,
            dir ? { folder: dir } : {},
          );
        } else {
          skip = result.reason;
        }
      } catch (error) {
        // A full disk is not this file's fault: stop here, cursor unmoved, and
        // let the job retry with backoff; the import resumes on this file.
        if (error instanceof StorageFull) throw error;
        // A file that vanished or cannot be read is skipped, not retried:
        // the folder is the owner's and may change under the import.
        skip = error instanceof Error ? error.message : String(error);
      }
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
