// The upload button's orchestration (docs/phases/1-map.md section 1, "web
// side"). `chooseUploadMethod` is the one pure decision — tested with no
// network, no DOM, no tus-js-client — everything else here talks to the
// server and is exercised by the smoke script instead.
import * as tus from 'tus-js-client';
import { type ImageStatus, SERVER_ORIGIN, api } from '../lib/api.ts';

export const TUS_THRESHOLD_BYTES = 8 * 1024 * 1024; // 8 MB
export const MULTIPART_BATCH_SIZE = 10;
export const POLL_INTERVAL_MS = 1000;
export const POLL_TIMEOUT_MS = 60_000;

/** Files over 8 MB go through tus (resumable, chunked); everything else is
 * one multipart request. The boundary the button and the smoke test agree on. */
export function chooseUploadMethod(sizeBytes: number): 'tus' | 'multipart' {
  return sizeBytes > TUS_THRESHOLD_BYTES ? 'tus' : 'multipart';
}

// 'failed' is the server's terminal state (the ladder job gave up after
// three attempts — @digsite/shared's ImageStatus); 'error' is ours, for a
// transport failure the server never got to answer (a rejected fetch, a
// missing response entry).
export type RowStatus = 'uploading' | ImageStatus | 'error';

export interface UploadRow {
  clientId: string;
  file: File;
  method: 'tus' | 'multipart';
  status: RowStatus;
  progress: number; // 0..100
  imageId?: string;
  error?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** One tus upload. The stub server does not implement /boards/:id/uploads
 * (see web/stub/server.ts) — onError there is exactly the 404/network path a
 * real server would also hit if tus were ever unreachable, so a fallback to
 * multipart is the honest behaviour for both, not a stub-only shortcut. */
function uploadOneTus(
  boardId: string,
  row: UploadRow,
  emit: () => void,
): Promise<'ok' | 'fallback'> {
  return new Promise((resolve) => {
    const upload = new tus.Upload(row.file, {
      endpoint: `${SERVER_ORIGIN}/boards/${boardId}/uploads`,
      chunkSize: 4 * 1024 * 1024,
      retryDelays: [0, 1000, 3000],
      metadata: { filename: row.file.name, properties: '{}' },
      // tus-js-client 4.x has no top-level `withCredentials` option (dropped
      // when it moved to an HttpStack abstraction); the underlying object is
      // the XHR, so this is the equivalent of the fetch wrapper's
      // `credentials: 'include'` for every other request.ts call.
      onBeforeRequest: (req) => {
        const xhr = req.getUnderlyingObject();
        if (xhr && typeof xhr === 'object' && 'withCredentials' in xhr) {
          (xhr as XMLHttpRequest).withCredentials = true;
        }
      },
      onProgress: (sent, total) => {
        row.progress = total ? Math.round((sent / total) * 100) : 0;
        emit();
      },
      onSuccess: () => {
        row.status = 'pending';
        row.progress = 100;
        emit();
        resolve('ok');
      },
      onError: (error) => {
        console.warn(
          `[upload] tus failed for "${row.file.name}": ${error.message} — falling back to multipart`,
        );
        resolve('fallback');
      },
    });
    upload.start();
  });
}

async function uploadMultipartBatches(
  boardId: string,
  rows: UploadRow[],
  emit: () => void,
): Promise<void> {
  for (let i = 0; i < rows.length; i += MULTIPART_BATCH_SIZE) {
    const batch = rows.slice(i, i + MULTIPART_BATCH_SIZE);
    try {
      const accepted = await api.uploadImages(
        boardId,
        batch.map((r) => r.file),
      );
      batch.forEach((row, j) => {
        const entry = accepted[j];
        if (entry) {
          row.imageId = entry.id;
          row.status = entry.status;
          row.progress = 100;
        } else {
          row.status = 'error';
          row.error = 'server returned no entry for this file';
        }
      });
    } catch (err) {
      for (const row of batch) {
        row.status = 'error';
        row.error = err instanceof Error ? err.message : String(err);
      }
    }
    emit();
  }
}

/** Rows still `pending` have no id (a tus upload) or a real one (multipart).
 * Poll the board's newest images and match: by id when we have one, else by
 * filename — tus's own success payload carries no image id (the ingest
 * happens server-side after the protocol's PATCH completes). Server agent:
 * if the tus completion can echo the created image id back some other way,
 * this name match goes away. */
async function pollUntilReady(
  boardId: string,
  rows: UploadRow[],
  emit: () => void,
): Promise<boolean> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  const claimed = new Set<string>();
  for (const row of rows) if (row.imageId) claimed.add(row.imageId);

  while (Date.now() < deadline) {
    const pending = rows.filter((r) => r.status === 'pending');
    if (!pending.length) return false;

    const { images } = await api.listBoardImages(
      boardId,
      'uploaded_at.desc',
      0,
      Math.max(rows.length, 1),
    );
    for (const row of pending) {
      const match = row.imageId
        ? images.find((img) => img.id === row.imageId)
        : images.find(
            (img) => img.name === row.file.name && !claimed.has(img.id),
          );
      if (match) {
        row.imageId = match.id;
        row.status = match.status;
        if (match.status === 'failed') row.error = match.error ?? undefined;
        claimed.add(match.id);
      }
    }
    emit();
    if (rows.every((r) => r.status !== 'pending' && r.status !== 'uploading')) {
      return false;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return true; // timed out with something still pending
}

export interface UploadResult {
  rows: UploadRow[];
  timedOut: boolean;
  allReady: boolean;
}

/** Drives every file to `ready` (or `error`, or a 60s timeout), calling
 * `onRows` with a fresh snapshot after every state change so a caller can
 * render progress rows. Returns once nothing is left `pending`/`uploading`. */
export async function runUpload(
  boardId: string,
  files: File[],
  onRows: (rows: UploadRow[]) => void,
): Promise<UploadResult> {
  const rows: UploadRow[] = files.map((file, i) => ({
    clientId: `${Date.now()}-${i}-${file.name}`,
    file,
    method: chooseUploadMethod(file.size),
    status: 'uploading',
    progress: 0,
  }));
  const emit = () => onRows(rows.slice());
  emit();

  const tusRows = rows.filter((r) => r.method === 'tus');
  const fellBack = new Set<string>();
  await Promise.all(
    tusRows.map(async (row) => {
      const result = await uploadOneTus(boardId, row, emit);
      if (result === 'fallback') fellBack.add(row.clientId);
    }),
  );

  const multipartRows = rows.filter(
    (r) => r.method === 'multipart' || fellBack.has(r.clientId),
  );
  await uploadMultipartBatches(boardId, multipartRows, emit);

  const timedOut = await pollUntilReady(boardId, rows, emit);
  const allReady = rows.every((r) => r.status === 'ready');
  return { rows, timedOut, allReady };
}

export type { ImageStatus };
