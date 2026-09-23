// Storage key builders (docs/phases/4-deploy.md section 1). Split out of
// upload.ts so the request path (upload.ts) and the worker (worker/jobs.ts)
// don't import each other: upload.ts enqueues the `ladder` job, and the job
// reads the original the request already wrote, by this same key. These
// used to build filesystem paths directly; since phase 4 they build
// Storage keys — under STORAGE=fs those keys are, byte-for-byte, the paths
// this module used to return (storage/fs.ts resolves a key as
// `${DATA_DIR}/<key>`), so existing data keeps working unmigrated.
import { GRID_LAYOUT_VERSION } from '@digsite/shared/board/grid';

export function coarseTilesPrefix(boardId: string, sortId: string): string {
  return `boards/${boardId}/tiles/grid-${GRID_LAYOUT_VERSION}/${sortId}/`;
}

export function originalKey(boardId: string, sha256: string): string {
  return `boards/${boardId}/originals/${sha256}`;
}

/** `GET /images/:id/preview`'s encode-once cache — a PNG of the original
 * scaled to at most 1024px on its longer side, keyed by the same sha256 as
 * the original (so two images sharing one original share one preview too). */
/** A camera file kept beside the JPEG intake made from it (intake.ts). */
export function sourceKey(boardId: string, sha256: string): string {
  return `boards/${boardId}/sources/${sha256}`;
}

export function previewKey(boardId: string, sha256: string): string {
  return `boards/${boardId}/previews/${sha256}.png`;
}
