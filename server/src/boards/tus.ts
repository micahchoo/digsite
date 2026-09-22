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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FileStore } from '@tus/file-store';
import { Server } from '@tus/server';
import { AccessDenied, boardForUploading } from '../access/index.ts';
import { auth } from '../auth.ts';
import { env } from '../env.ts';
import { uploadOne } from './upload.ts';

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
    await uploadOne(meta.boardId, meta.userId, filename, bytes, properties);
    await fileStore.remove(upload.id).catch(() => {});

    return {};
  },
});
