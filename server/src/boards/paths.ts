// The on-disk path for a board's stored originals. Split out of upload.ts so
// the request path (upload.ts) and the worker (worker/jobs.ts) don't import
// each other: upload.ts enqueues the `ladder` job, and the job reads the
// original the request already wrote, by this same path.
import { env } from '../env.ts';

export function originalPath(boardId: string, sha256: string): string {
  return `${env.DATA_DIR}/boards/${boardId}/originals/${sha256}`;
}
