// CONTEXT.md "Folder import": a board filled from a folder on the server's
// own disk, so a large library never passes through a browser's file
// chooser (which took seconds just to open on a 20,000-file folder).
//
// The boundary is the operator's: env.IMPORT_ROOTS lists the folders the
// server may read, and none by default. A path is resolved with realpath —
// symlinks and `..` included — and must land inside a root. Every file then
// takes the same intake as a browser upload (intake.ts), with duplicates
// skipped.
import { readdir, realpath, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { FolderImport } from '@digsite/shared/api';
import { pool } from '../db/pool.ts';
import { env } from '../env.ts';
import { QuotaExceeded } from '../storage/quota.ts';
import { schedule } from '../worker/schedule.ts';
import { isCameraFile } from './camera.ts';

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
  if (files.length) await schedule('folder-import', { importId: id });
  return {
    id,
    path: folder,
    total: files.length,
    imported: 0,
    skipped: 0,
    unchanged: 0,
    skips: [],
    state: files.length ? 'running' : 'done',
  };
}

export async function folderImport(
  boardId: string,
  importId: string,
): Promise<FolderImport | null> {
  const { rows } = await pool.query(
    `SELECT id, path, cardinality(files) AS total, imported, skipped, unchanged, skips, state,
       stop_reason AS "stopReason"
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
  // Loaded here: intake reaches the worker's queue, and the worker's jobs
  // module imports this one.
  const intake = await import('./intake.ts');
  const known = await filesKnown(job.board_id, job.path, job.batch);
  for (const file of job.batch as string[]) {
    const full = join(job.path, file);
    const seen = await statOf(full);
    // Unchanged since an earlier import put it on this board: passed over
    // without reading it.
    const was = known.get(full);
    if (seen && was && was.size === seen.size && was.mtimeMs === seen.mtimeMs) {
      await pool.query(
        `UPDATE folder_imports SET next = next + 1, unchanged = unchanged + 1
         WHERE id = $1`,
        [importId],
      );
      continue;
    }
    const admitted = await admit(intake, job.board_id, job.path, file);
    const skip = admitted.ok ? null : admitted.reason;
    if (admitted.ok) {
      // Not caught: a failure here is the server's (storage, database, a
      // full disk), never this file's. The job retries with the cursor
      // unmoved, and the import resumes on this file. Before, a missing
      // DATA_DIR skipped every file of a 901-file import as its own fault.
      try {
        await intake.store(job.board_id, job.user_id, admitted);
      } catch (error) {
        // The group's storage is full: every later file would fail the
        // same way, so the import stops here, cursor unmoved, and says
        // why. Started again, it resumes on this file.
        if (!(error instanceof QuotaExceeded)) throw error;
        await pool.query(
          `UPDATE folder_imports SET state = 'stopped', stop_reason = $2
           WHERE id = $1`,
          [
            importId,
            `group storage is full (${error.usedBytes} of ${error.quotaBytes} bytes)`,
          ],
        );
        return;
      }
    }
    // Its bytes are on the board now, stored this time or found there:
    // the next import of this folder can pass it over while it is unchanged.
    if (seen && (admitted.ok || admitted.status === 409)) {
      await pool.query(
        `INSERT INTO folder_files (board_id, path, size, mtime_ms)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (board_id, path)
           DO UPDATE SET size = EXCLUDED.size, mtime_ms = EXCLUDED.mtime_ms`,
        [job.board_id, full, seen.size, seen.mtimeMs],
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
    await schedule('folder-import', { importId });
  }
}

/** One file of the folder, examined, or why it is skipped. Only the
 * FILE's faults are skips: it vanished, cannot be read, or intake refused
 * it — including bytes already on this board (C6: a folder imported twice
 * made every image twice). */
async function admit(
  intake: typeof import('./intake.ts'),
  boardId: string,
  folder: string,
  file: string,
): Promise<import('./intake.ts').Examined | import('./intake.ts').Refused> {
  const name = file.slice(file.lastIndexOf(sep) + 1);
  const dir = file.includes(sep) ? file.slice(0, file.lastIndexOf(sep)) : '';
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await Bun.file(join(folder, file)).arrayBuffer());
  } catch (error) {
    // The folder is the owner's and may change under the import.
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, status: 404, reason };
  }
  return intake.examine(
    boardId,
    { name, bytes, properties: dir ? { folder: dir } : {} },
    { skipDuplicates: true },
  );
}

/** Starts a stopped import again on the file it stopped at. False when
 * the import is not stopped (running, done, or not on this board). */
export async function resumeFolderImport(
  boardId: string,
  importId: string,
): Promise<boolean> {
  const { rows } = await pool.query(
    `UPDATE folder_imports SET state = 'running', stop_reason = NULL
     WHERE board_id = $1 AND id::text = $2 AND state = 'stopped'
     RETURNING id`,
    [boardId, importId],
  );
  if (rows.length === 0) return false;
  await schedule('folder-import', { importId: rows[0].id });
  return true;
}

/** What earlier imports recorded for this batch's files, by full path. */
async function filesKnown(
  boardId: string,
  folder: string,
  batch: string[],
): Promise<Map<string, { size: number; mtimeMs: number }>> {
  const { rows } = await pool.query(
    `SELECT path, size, mtime_ms FROM folder_files
     WHERE board_id = $1 AND path = ANY($2::text[])`,
    [boardId, batch.map((file) => join(folder, file))],
  );
  return new Map(
    rows.map((r) => [
      r.path as string,
      { size: Number(r.size), mtimeMs: Number(r.mtime_ms) },
    ]),
  );
}

/** A file's size and whole-millisecond modification time, or null when it
 * cannot be read (it is then examined, and skipped with the reason). */
async function statOf(
  path: string,
): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const info = await stat(path);
    return { size: info.size, mtimeMs: Math.floor(info.mtimeMs) };
  } catch {
    return null;
  }
}
