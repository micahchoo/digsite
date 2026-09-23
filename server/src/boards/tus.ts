// Resumable uploads (docs/phases/1-map.md "Upload as a worker"): @tus/server
// + @tus/file-store mounted at /boards/:id/uploads (and /boards/:id/uploads/*
// for the same upload's follow-up requests). The gate is `onIncomingRequest`
// — read ../../research/tus-node-server/packages/server/src/server.ts —
// running `boardForUploading` with the session cookie before every method,
// same predicate as the multipart route. `onUploadFinish` reads the
// finished file back off disk and calls the same `uploadOne` the multipart
// path calls, then deletes the tus file: a tus upload becomes exactly the
// same pending row and ladder job either way, and (unlike the multipart
// route) it never waits for the job — see server/README.md.
//
// Staging stays on local disk under DATA_DIR/tus regardless of STORAGE
// (docs/phases/4-deploy.md section 1 names "tus staging" among what goes
// through Storage — this is the one exception, and deliberately so):
// @tus/file-store's resumable-chunk protocol is its own append-in-place
// format, which the Storage interface's put/get/exists/delete (no append)
// can't express, and @tus/s3-store would mean a second S3 client and a
// second failure mode for what is, either way, a few-second-lived scratch
// file. What matters for phase 4 is that the PERMANENT artifact — the
// original `uploadOne` writes below — goes through Storage exactly like
// the multipart route's; that both upload paths share `uploadOne` is what
// makes that true regardless of what's above this comment.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FileStore } from '@tus/file-store';
import { Server } from '@tus/server';
import { AccessDenied, boardForUploading } from '../access/index.ts';
import { auth } from '../auth.ts';
import { env } from '../env.ts';
import { checkLimit } from '../limits.ts';
import { StorageFull } from '../storage/room.ts';
import { examine, store } from './intake.ts';

const TUS_MOUNT = /^\/boards\/([^/]+)\/uploads(?:\/([^/]+))?\/?$/;

export function isTusPath(pathname: string): boolean {
  return TUS_MOUNT.test(pathname);
}

function boardIdFromPathname(pathname: string): string | null {
  return TUS_MOUNT.exec(pathname)?.[1] ?? null;
}

// onIncomingRequest (called before every method, including the POST that
// creates the upload) is the only hook that sees both the request and the
// resolved upload id, so it is where we learn who is uploading to which
// board; onUploadFinish only receives the Upload. Cleared once read.
const uploaders = new Map<string, { boardId: string; userId: string }>();

const fileStore = new FileStore({ directory: `${env.DATA_DIR}/tus` });

export const tusServer = new Server({
  path: '/boards',
  datastore: fileStore,
  allowedOrigins: [env.WEB_ORIGIN],
  allowedCredentials: true,
  exposedHeaders: [
    'Upload-Offset',
    'Upload-Length',
    'Tus-Resumable',
    'Location',
    'Upload-Image-Id',
  ],

  generateUrl: (req, { id }) => {
    const boardId = boardIdFromPathname(new URL(req.url).pathname);
    return `/boards/${boardId}/uploads/${id}`;
  },

  getFileIdFromRequest: (req) => TUS_MOUNT.exec(new URL(req.url).pathname)?.[2],

  onIncomingRequest: async (req, uploadId) => {
    const boardId = boardIdFromPathname(new URL(req.url).pathname);
    if (!boardId) throw { status_code: 404, body: 'unknown board\n' };

    const session = await auth.api.getSession({ headers: req.headers });
    const userId = session?.user.id;
    if (!userId) throw { status_code: 401, body: 'unauthorized\n' };

    try {
      await boardForUploading(userId, boardId);
    } catch (err) {
      if (err instanceof AccessDenied) {
        throw { status_code: 403, body: `${err.reason}\n` };
      }
      throw err;
    }

    // Phase 5 section 2 (docs/phases/5-hardening.md "Abuse limits"): "tus
    // 20 creates/min" — a POST is the one method tus uses to create a new
    // upload (a PATCH continues an existing one by id, per the mount
    // regex — TUS_MOUNT); onIncomingRequest runs before every method, so
    // this only charges the bucket for the create, never a chunk's PATCH.
    if (req.method === 'POST') {
      const limit = checkLimit('tus-create', userId);
      if (!limit.allowed) {
        // @tus/server's thrown-error shape is `{status_code, body}` only
        // (server.ts's `onError`) — no headers, so `Retry-After` travels
        // in the body instead of as its own header here.
        throw {
          status_code: 429,
          body: JSON.stringify({
            reason: 'tus-create',
            retryAfter: limit.retryAfter,
          }),
        };
      }
    }

    if (uploadId) uploaders.set(uploadId, { boardId, userId });
  },

  onUploadFinish: async (_req, upload) => {
    const meta = uploaders.get(upload.id);
    uploaders.delete(upload.id);
    if (!meta) throw { status_code: 500, body: 'upload not gated\n' };

    const filename = upload.metadata?.filename || `upload-${Date.now()}`;
    let properties: Record<string, unknown> = {};
    const raw = upload.metadata?.properties;
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') properties = parsed;
      } catch {
        // properties stays empty — same tolerance as the multipart path
      }
    }

    const bytes = new Uint8Array(
      readFileSync(join(env.DATA_DIR, 'tus', upload.id)),
    );

    // The same intake as the multipart route (intake.ts). The finished tus
    // file is removed either way; a refused upload has nothing left to
    // resume.
    const examined = await examine(meta.boardId, {
      name: filename,
      bytes,
      properties,
    });
    if (!examined.ok) {
      await fileStore.remove(upload.id).catch(() => {});
      throw { status_code: examined.status, body: `${examined.reason}\n` };
    }
    let image: Awaited<ReturnType<typeof store>>;
    try {
      image = await store(meta.boardId, meta.userId, examined);
    } catch (err) {
      if (!(err instanceof StorageFull)) throw err;
      await fileStore.remove(upload.id).catch(() => {});
      throw { status_code: 507, body: `${err.message}\n` };
    }
    await fileStore.remove(upload.id).catch(() => {});

    return { headers: { 'Upload-Image-Id': image.id } };
  },
});
