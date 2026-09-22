// The on-disk path for a board's stored originals. Split out of upload.ts so
// the request path (upload.ts) and the worker (worker/jobs.ts) don't import
// each other: upload.ts enqueues the `ladder` job, and the job reads the
// original the request already wrote, by this same path.
import { env } from '../env.ts';

export function originalPath(boardId: string, sha256: string): string {
  return `${env.DATA_DIR}/boards/${boardId}/originals/${sha256}`;
}

/** `GET /images/:id/preview`'s encode-once cache — a PNG of the original
 * scaled to at most 1024px on its longer side, keyed by the same sha256 as
 * the original (so two images sharing one original share one preview too). */
export function previewPath(boardId: string, sha256: string): string {
  return `${env.DATA_DIR}/boards/${boardId}/previews/${sha256}.png`;
}
