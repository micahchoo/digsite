// Upload work outlives a board page. Keep one in-memory queue per board so
// route changes do not orphan accepted IDs or start duplicate transfers.
import * as tus from 'tus-js-client';
import { ApiError, type ImageStatus, SERVER_ORIGIN, api } from '../lib/api.ts';
import { bytesLabel } from '../lib/bytes.ts';

export const TUS_THRESHOLD_BYTES = 8 * 1024 * 1024;
export const MULTIPART_BATCH_SIZE = 10;
export const POLL_INTERVAL_MS = 1500;
export const MAX_UPLOAD_CONCURRENCY = 2;
export const VISIBLE_UPLOAD_ROWS = 80;

export function chooseUploadMethod(sizeBytes: number): 'tus' | 'multipart' {
  return sizeBytes > TUS_THRESHOLD_BYTES ? 'tus' : 'multipart';
}

export type RowStatus =
  | 'queued'
  | 'uploading'
  | ImageStatus
  | 'error'
  | 'unknown'
  | 'canceled';

export interface UploadRow {
  clientId: string;
  name: string;
  size: number;
  file: File | null;
  method: 'tus' | 'multipart';
  status: RowStatus;
  progress: number;
  imageId?: string;
  error?: string;
  statusMisses?: number;
}

export interface UploadCounts {
  queued: number;
  uploading: number;
  processing: number;
  ready: number;
  failed: number;
  unknown: number;
  canceled: number;
}

export interface UploadSnapshot {
  boardId: string;
  rows: UploadRow[];
  counts: UploadCounts;
  visible: boolean;
  canceling: boolean;
  message: string;
  version: number;
  refreshVersion: number;
  tileRefreshVersion: number;
}

const EMPTY_COUNTS: UploadCounts = {
  queued: 0,
  uploading: 0,
  processing: 0,
  ready: 0,
  failed: 0,
  unknown: 0,
  canceled: 0,
};
const EMPTY_SNAPSHOT: UploadSnapshot = {
  boardId: '',
  rows: [],
  counts: EMPTY_COUNTS,
  visible: false,
  canceling: false,
  message: '',
  version: 0,
  refreshVersion: 0,
  tileRefreshVersion: 0,
};

interface QueueSession {
  boardId: string;
  rows: UploadRow[];
  counts: UploadCounts;
  listeners: Set<() => void>;
  snapshot: UploadSnapshot;
  visible: boolean;
  canceling: boolean;
  message: string;
  retryAt: number;
  retryTimer: number | null;
  retrySeconds: number;
  activeTasks: number;
  activeControllers: Set<AbortController>;
  activeTus: Set<tus.Upload>;
  nextIndex: number;
  refreshVersion: number;
  tileRefreshVersion: number;
  dirty: boolean;
  publishTimer: number | null;
}

const sessions = new Map<string, QueueSession>();
let activeTransfers = 0;
let nextSessionIndex = 0;
const UPLOADS_PER_SESSION = 2;
const STATUS_BATCH_SIZE = 500;
let statusWorkers = 0;
let statusAbortController: AbortController | null = null;
let shuttingDown = false;
let unloadAttached = false;
let overview: UploadOverview[] = [];
const overviewListeners = new Set<() => void>();

export interface UploadOverview {
  boardId: string;
  counts: UploadCounts;
}

function sessionFor(boardId: string): QueueSession {
  let session = sessions.get(boardId);
  if (!session) {
    session = {
      boardId,
      rows: [],
      counts: { ...EMPTY_COUNTS },
      listeners: new Set(),
      snapshot: EMPTY_SNAPSHOT,
      visible: false,
      canceling: false,
      message: '',
      retryAt: 0,
      retryTimer: null,
      retrySeconds: 0,
      activeTasks: 0,
      activeControllers: new Set(),
      activeTus: new Set(),
      nextIndex: 0,
      refreshVersion: 0,
      tileRefreshVersion: 0,
      dirty: false,
      publishTimer: null,
    };
    sessions.set(boardId, session);
  }
  return session;
}

function bucket(status: RowStatus): keyof UploadCounts {
  if (status === 'pending') return 'processing';
  if (status === 'error' || status === 'failed') return 'failed';
  if (status === 'uploading') return 'uploading';
  return status;
}

function publish(session: QueueSession, immediate = false) {
  if (!immediate) {
    session.dirty = true;
    if (session.publishTimer !== null) return;
    session.publishTimer = window.setTimeout(() => {
      session.publishTimer = null;
      publish(session, true);
    }, 100);
    return;
  }
  if (session.publishTimer !== null) {
    window.clearTimeout(session.publishTimer);
    session.publishTimer = null;
  }
  session.dirty = false;
  session.snapshot = {
    boardId: session.boardId,
    rows: session.rows,
    counts: { ...session.counts },
    visible: session.visible,
    canceling: session.canceling,
    message: session.message,
    version: session.snapshot.version + 1,
    refreshVersion: session.refreshVersion,
    tileRefreshVersion: session.tileRefreshVersion,
  };
  for (const listener of session.listeners) listener();
  const nextOverview = [...sessions.values()]
    .filter(
      (item) =>
        item.counts.queued +
          item.counts.uploading +
          item.counts.processing +
          item.counts.failed +
          item.counts.unknown >
        0,
    )
    .map((item) => ({ boardId: item.boardId, counts: { ...item.counts } }));
  if (JSON.stringify(nextOverview) !== JSON.stringify(overview)) {
    overview = nextOverview;
    for (const listener of overviewListeners) listener();
  }
  updateBeforeUnload();
}

function updateBeforeUnload() {
  const active = [...sessions.values()].some(
    (session) => session.counts.queued + session.counts.uploading > 0,
  );
  if (active && !unloadAttached) {
    window.addEventListener('beforeunload', warnBeforeUnload);
    unloadAttached = true;
  } else if (!active && unloadAttached) {
    window.removeEventListener('beforeunload', warnBeforeUnload);
    unloadAttached = false;
  }
}

function warnBeforeUnload(event: BeforeUnloadEvent) {
  event.preventDefault();
  event.returnValue = '';
}

function setStatus(
  session: QueueSession,
  row: UploadRow,
  next: RowStatus,
  error?: string,
) {
  if (row.status !== next) {
    session.counts[bucket(row.status)] -= 1;
    session.counts[bucket(next)] += 1;
    if (row.status === 'pending' && (next === 'ready' || next === 'failed')) {
      session.tileRefreshVersion += 1;
    }
    row.status = next;
  }
  if (error !== undefined) row.error = error;
}

export function subscribeUploadQueue(boardId: string, listener: () => void) {
  const session = sessionFor(boardId);
  session.listeners.add(listener);
  return () => session.listeners.delete(listener);
}

export function getUploadSnapshot(boardId: string): UploadSnapshot {
  return sessions.get(boardId)?.snapshot ?? EMPTY_SNAPSHOT;
}

export function subscribeUploadOverview(listener: () => void) {
  overviewListeners.add(listener);
  return () => overviewListeners.delete(listener);
}

export function getUploadOverview(): UploadOverview[] {
  return overview;
}

function hasQueued(session: QueueSession) {
  return (
    !shuttingDown &&
    sessions.get(session.boardId) === session &&
    !session.canceling &&
    session.activeTasks < UPLOADS_PER_SESSION &&
    session.counts.queued > 0
  );
}

function nextBatch(session: QueueSession): UploadRow[] {
  while (
    session.nextIndex < session.rows.length &&
    session.rows[session.nextIndex]?.status !== 'queued'
  ) {
    session.nextIndex += 1;
  }
  const firstIndex = session.nextIndex;
  const first = session.rows[firstIndex];
  if (!first) return [];
  if (first.method === 'tus') {
    session.nextIndex += 1;
    return [first];
  }
  const batch: UploadRow[] = [];
  while (batch.length < MULTIPART_BATCH_SIZE) {
    const row = session.rows[session.nextIndex];
    if (!row || row.status !== 'queued' || row.method !== 'multipart') break;
    batch.push(row);
    session.nextIndex += 1;
  }
  return batch;
}

function pickSession(): QueueSession | null {
  const now = Date.now();
  const available = [...sessions.values()];
  for (let offset = 0; offset < available.length; offset += 1) {
    const index = (nextSessionIndex + offset) % available.length;
    const session = available[index];
    if (session && hasQueued(session) && session.retryAt <= now) {
      nextSessionIndex = (index + 1) % available.length;
      return session;
    }
  }
  return null;
}

function scheduleRetry(session: QueueSession, seconds: number) {
  if (session.canceling || shuttingDown) return;
  session.retrySeconds = Math.max(1, Math.ceil(seconds));
  session.retryAt = Date.now() + session.retrySeconds * 1000;
  session.message = `The upload limit is reached. Waiting ${session.retrySeconds} seconds before continuing.`;
  if (session.retryTimer !== null) window.clearInterval(session.retryTimer);
  session.retryTimer = window.setInterval(() => {
    const remaining = Math.max(
      0,
      Math.ceil((session.retryAt - Date.now()) / 1000),
    );
    session.retrySeconds = remaining;
    session.message = remaining
      ? `The upload limit is reached. Waiting ${remaining} seconds before continuing.`
      : '';
    publish(session, true);
    if (!remaining && session.retryTimer !== null) {
      window.clearInterval(session.retryTimer);
      session.retryTimer = null;
      pumpTransfers();
    }
  }, 1000);
  publish(session, true);
}

function startTus(
  session: QueueSession,
  row: UploadRow,
): Promise<{
  id: string | null;
  error?: string;
  status?: number;
  retryAfter?: number;
  fallback?: boolean;
  body?: unknown;
}> {
  if (!row.file)
    return Promise.resolve({ id: null, error: 'File is unavailable.' });
  return new Promise((resolve) => {
    let imageId: string | null = null;
    const upload = new tus.Upload(row.file as File, {
      endpoint: `${SERVER_ORIGIN}/boards/${sessionBoardForRow(row)}/uploads`,
      chunkSize: 4 * 1024 * 1024,
      retryDelays: [0, 1000, 3000],
      // tus-js-client's own rule, plus one: a full disk (507) stays full,
      // and retrying only writes more into it.
      onShouldRetry: (error) => {
        const status = error.originalResponse?.getStatus() ?? 0;
        if (status === 507 || status === 413) return false;
        const client = status >= 400 && status < 500;
        return (
          (!client || status === 409 || status === 423) && navigator.onLine
        );
      },
      metadata: { filename: row.name, properties: '{}' },
      onBeforeRequest: (req) => {
        const xhr = req.getUnderlyingObject();
        if (xhr && typeof xhr === 'object' && 'withCredentials' in xhr) {
          (xhr as XMLHttpRequest).withCredentials = true;
        }
      },
      onAfterResponse: (_req, response) => {
        imageId = response.getHeader('Upload-Image-Id') ?? imageId;
      },
      onProgress: (sent, total) => {
        row.progress = total ? Math.round((sent / total) * 100) : 0;
        const session = sessions.get(sessionBoardForRow(row));
        if (session) publish(session);
      },
    });
    session.activeTus.add(upload);
    const finish = (result: {
      id: string | null;
      error?: string;
      status?: number;
      retryAfter?: number;
      fallback?: boolean;
      body?: unknown;
    }) => {
      session.activeTus.delete(upload);
      resolve(result);
    };
    upload.options.onSuccess = () => {
      row.progress = 100;
      finish({ id: imageId });
    };
    upload.options.onError = (error) => {
      const detailed = error as tus.DetailedError;
      const status = detailed.originalResponse?.getStatus();
      let retryAfter = Number(
        detailed.originalResponse?.getHeader('Retry-After') ?? Number.NaN,
      );
      let body: unknown = null;
      try {
        body = JSON.parse(detailed.originalResponse?.getBody() ?? 'null');
      } catch {
        // The server may return an HTML or empty error body.
      }
      const bodyRetry = (body as { retryAfter?: unknown } | null)?.retryAfter;
      if (!Number.isFinite(retryAfter) && typeof bodyRetry === 'number')
        retryAfter = bodyRetry;
      const fallback =
        status === 404 &&
        detailed.originalRequest?.getMethod() === 'POST' &&
        imageId === null;
      finish({
        id: imageId,
        error: error.message,
        status,
        retryAfter: Number.isFinite(retryAfter) ? retryAfter : undefined,
        fallback,
        body,
      });
    };
    upload.start();
  });
}

/** The server's disk is full (507). Nothing else in the queue can land, so
 * the batch that hit it fails, everything still queued stops, and the
 * panel says why. Retrying would only fill the disk further. */
function stopForFullDisk(session: QueueSession, batch: readonly UploadRow[]) {
  for (const row of batch) {
    setStatus(session, row, 'error', "The server's disk is full.");
    row.file = null;
  }
  for (const row of session.rows) {
    if (row.status !== 'queued') continue;
    setStatus(session, row, 'canceled');
    row.file = null;
  }
  session.message =
    "Uploads stopped: the server's disk is full. Ask whoever runs this server to free space, then add the remaining files again.";
  publish(session, true);
}

/** A 413 from a group whose storage is full, read from its body; null for
 * any other refusal. */
export function quotaOf(body: unknown): {
  usedBytes: number;
  quotaBytes: number;
  accepted?: { name: string; id: string }[];
} | null {
  const b = body as {
    reason?: unknown;
    usedBytes?: unknown;
    quotaBytes?: unknown;
    accepted?: unknown;
  } | null;
  if (b?.reason !== 'quota') return null;
  if (typeof b.usedBytes !== 'number' || typeof b.quotaBytes !== 'number')
    return null;
  const accepted = Array.isArray(b.accepted)
    ? b.accepted.filter(
        (a): a is { name: string; id: string } =>
          typeof a?.name === 'string' && typeof a?.id === 'string',
      )
    : undefined;
  return {
    usedBytes: b.usedBytes,
    quotaBytes: b.quotaBytes,
    ...(accepted ? { accepted } : {}),
  };
}

/** The group's storage is full (413, reason quota). Like a full disk,
 * nothing else in the queue can land. In a batch, the files before the one
 * that crossed the line were kept: those the server names are pending, the
 * rest failed; when it names none, which landed is unknown. */
function stopForFullStorage(
  session: QueueSession,
  batch: readonly UploadRow[],
  quota: NonNullable<ReturnType<typeof quotaOf>>,
) {
  const kept = [...(quota.accepted ?? [])];
  for (const row of batch) {
    // Names repeat in a batch, so each accepted file matches one row, in
    // order.
    const at = kept.findIndex((a) => a.name === row.name);
    if (at >= 0) {
      row.imageId = kept.splice(at, 1)[0]?.id;
      setStatus(session, row, 'pending');
      row.file = null;
      continue;
    }
    if (quota.accepted || batch.length === 1)
      setStatus(session, row, 'error', "The group's storage is full.");
    else
      setStatus(
        session,
        row,
        'unknown',
        "The group's storage filled during this batch. Refresh the board to see whether this file was added.",
      );
    row.file = null;
  }
  for (const row of session.rows) {
    if (row.status !== 'queued') continue;
    setStatus(session, row, 'canceled');
    row.file = null;
  }
  session.message = `Uploads stopped: this group's storage is full (${bytesLabel(quota.usedBytes)} of ${bytesLabel(quota.quotaBytes)}). Delete pictures the group no longer needs, or ask whoever runs this server for more space, then add the remaining files again.`;
  publish(session, true);
  if (kept.length < (quota.accepted?.length ?? 0)) scheduleStatusPoll(session);
}

// UploadRow doesn't carry board identity, so task-local lookup is explicit.
const rowBoards = new WeakMap<UploadRow, string>();
function sessionBoardForRow(row: UploadRow) {
  return rowBoards.get(row) ?? '';
}

async function uploadBatch(session: QueueSession, batch: UploadRow[]) {
  for (const row of batch) setStatus(session, row, 'uploading');
  session.message = '';
  publish(session, true);
  if (batch[0]?.method === 'tus') {
    const row = batch[0];
    if (!row) return;
    const result = await startTus(session, row);
    if (result.fallback) {
      row.method = 'multipart';
      if (session.canceling) {
        setStatus(session, row, 'canceled');
        row.file = null;
      } else {
        setStatus(session, row, 'queued');
        session.nextIndex = Math.min(
          session.nextIndex,
          session.rows.indexOf(row),
        );
      }
      publish(session, true);
      return;
    }
    if (result.status === 429 && !result.id) {
      if (session.canceling) {
        setStatus(session, row, 'canceled');
        row.file = null;
      } else {
        setStatus(session, row, 'queued');
        session.nextIndex = Math.min(
          session.nextIndex,
          session.rows.indexOf(row),
        );
        scheduleRetry(session, result.retryAfter ?? 60);
      }
      publish(session, true);
      return;
    }
    if (result.status === 507) {
      stopForFullDisk(session, [row]);
      return;
    }
    const tusQuota = result.status === 413 ? quotaOf(result.body) : null;
    if (tusQuota) {
      stopForFullStorage(session, [row], tusQuota);
      return;
    }
    if (!result.id) {
      setStatus(
        session,
        row,
        'unknown',
        `Could not confirm the resumable upload. Refresh the board before selecting this file again.${result.error ? ` ${result.error}` : ''}`,
      );
      row.file = null;
    } else {
      row.imageId = result.id;
      setStatus(session, row, 'pending');
      row.file = null;
      scheduleStatusPoll(session);
    }
    publish(session, true);
    return;
  }

  for (;;) {
    const controller = new AbortController();
    session.activeControllers.add(controller);
    try {
      const accepted = await api.uploadImages(
        session.boardId,
        batch.map((row) => row.file).filter((file): file is File => !!file),
        controller.signal,
      );
      for (const [index, row] of batch.entries()) {
        const entry = accepted[index];
        if (entry) {
          row.imageId = entry.id;
          setStatus(session, row, entry.status);
          session.refreshVersion += 1;
          if (entry.status === 'ready' || entry.status === 'failed') {
            session.tileRefreshVersion += 1;
          }
        } else {
          setStatus(
            session,
            row,
            'unknown',
            'The server did not identify this image. Refresh the board before selecting this file again.',
          );
        }
        row.file = null;
      }
      publish(session, true);
      scheduleStatusPoll(session);
      return;
    } catch (error) {
      if (error instanceof ApiError && error.status === 429) {
        if (session.canceling || shuttingDown) {
          for (const row of batch) {
            setStatus(session, row, 'canceled');
            row.file = null;
          }
          publish(session, true);
          return;
        }
        for (const row of batch) setStatus(session, row, 'queued');
        session.nextIndex = Math.min(
          session.nextIndex,
          session.rows.indexOf(batch[0] as UploadRow),
        );
        publish(session, true);
        scheduleRetry(session, error.retryAfter ?? 60);
        return;
      }
      if (error instanceof ApiError && error.status === 507) {
        stopForFullDisk(session, batch);
        return;
      }
      const quota =
        error instanceof ApiError && error.status === 413
          ? quotaOf(error.body)
          : null;
      if (quota) {
        stopForFullStorage(session, batch, quota);
        return;
      }
      const definiteRejection =
        error instanceof ApiError && error.status >= 400 && error.status < 500;
      for (const row of batch) {
        setStatus(
          session,
          row,
          definiteRejection ? 'error' : 'unknown',
          definiteRejection
            ? error.message
            : 'Could not confirm whether this upload was accepted. Refresh the board before selecting this file again.',
        );
        row.file = null;
      }
      publish(session, true);
      return;
    } finally {
      session.activeControllers.delete(controller);
    }
  }
}

function pumpTransfers() {
  while (activeTransfers < MAX_UPLOAD_CONCURRENCY) {
    const session = pickSession();
    if (!session) return;
    const batch = nextBatch(session);
    if (!batch.length) return;
    session.activeTasks += 1;
    activeTransfers += 1;
    void uploadBatch(session, batch).finally(() => {
      session.activeTasks -= 1;
      activeTransfers -= 1;
      if (session.canceling && session.activeTasks === 0) {
        session.canceling = false;
        session.message = session.counts.processing
          ? 'Queued uploads stopped. Accepted images are still processing.'
          : 'Queued uploads stopped.';
      }
      publish(session, true);
      pumpTransfers();
    });
  }
}

let statusTimer: number | null = null;
function scheduleStatusPoll(session: QueueSession) {
  if (shuttingDown || statusTimer !== null || statusWorkers > 0) return;
  statusTimer = window.setTimeout(() => {
    statusTimer = null;
    void pollStatuses();
  }, POLL_INTERVAL_MS);
  // Polling starts independently of uploads so accepted images settle while
  // later batches continue through the bounded transfer pool.
  async function pollStatuses() {
    const pendingSessions = [...sessions.values()].filter(
      (s) => s.counts.processing > 0,
    );
    if (!pendingSessions.length) return;
    statusWorkers += 1;
    const controller = new AbortController();
    statusAbortController = controller;
    for (const currentSession of pendingSessions) {
      const pending = currentSession.rows.filter(
        (row) => row.status === 'pending' && row.imageId,
      );
      for (let index = 0; index < pending.length; index += STATUS_BATCH_SIZE) {
        const group = pending.slice(index, index + STATUS_BATCH_SIZE);
        try {
          const result = await api.uploadImageStatuses(
            currentSession.boardId,
            group.map((row) => row.imageId as string),
            controller.signal,
          );
          const byId = new Map(result.images.map((image) => [image.id, image]));
          for (const row of group) {
            const image = row.imageId ? byId.get(row.imageId) : undefined;
            if (!image) {
              row.statusMisses = (row.statusMisses ?? 0) + 1;
              if (row.statusMisses >= 5) {
                setStatus(
                  currentSession,
                  row,
                  'unknown',
                  'No status was returned for this accepted image. Refresh the board before selecting this file again.',
                );
              }
              continue;
            }
            row.statusMisses = 0;
            setStatus(
              currentSession,
              row,
              image.status,
              image.error ?? undefined,
            );
            if (image.status === 'ready' || image.status === 'failed') {
              row.file = null;
              currentSession.refreshVersion += 1;
            }
          }
          publish(currentSession, true);
        } catch (error) {
          if (controller.signal.aborted) break;
          // Status reads are safe to repeat: the IDs are known and immutable.
          if (
            error instanceof ApiError &&
            error.status >= 400 &&
            error.status < 500
          ) {
            currentSession.message =
              'Could not confirm image processing because access is unavailable.';
            for (const row of currentSession.rows) {
              if (row.status !== 'pending') continue;
              setStatus(
                currentSession,
                row,
                'unknown',
                'Could not check image status because access is unavailable. Reopen the board before trying again.',
              );
            }
            publish(currentSession, true);
            break;
          }
          currentSession.message =
            'Couldn’t confirm image status. Checking again.';
          publish(currentSession, true);
        }
      }
    }
    statusWorkers -= 1;
    if (statusAbortController === controller) statusAbortController = null;
    if (shuttingDown) return;
    const stillProcessing = [...sessions.values()].find(
      (s) => s.counts.processing > 0,
    );
    if (stillProcessing) {
      scheduleStatusPoll(stillProcessing);
    }
  }
}

export function enqueueUploads(boardId: string, files: File[]) {
  shuttingDown = false;
  const session = sessionFor(boardId);
  if (
    session.activeTasks === 0 &&
    session.counts.queued === 0 &&
    session.counts.processing === 0 &&
    session.counts.failed === 0 &&
    session.counts.unknown === 0
  ) {
    session.rows = [];
    session.counts = { ...EMPTY_COUNTS };
    session.nextIndex = 0;
  }
  session.visible = true;
  if (session.activeTasks === 0) session.canceling = false;
  session.message = '';
  const base = Date.now();
  for (const [index, file] of files.entries()) {
    const row: UploadRow = {
      clientId: `${base}-${index}-${file.name}`,
      name: file.name,
      size: file.size,
      file,
      method: chooseUploadMethod(file.size),
      status: 'queued',
      progress: 0,
    };
    rowBoards.set(row, boardId);
    session.rows.push(row);
    session.counts.queued += 1;
  }
  publish(session, true);
  pumpTransfers();
}

export function stopQueuedUploads(boardId: string) {
  const session = sessions.get(boardId);
  if (!session) return;
  session.canceling = true;
  if (session.retryTimer !== null) {
    window.clearInterval(session.retryTimer);
    session.retryTimer = null;
    session.retryAt = 0;
  }
  for (const row of session.rows) {
    if (row.status === 'queued') {
      setStatus(session, row, 'canceled');
      row.file = null;
    }
  }
  session.message = session.activeTasks
    ? 'Stopping after the current uploads finish…'
    : 'Queued uploads stopped.';
  if (session.activeTasks === 0) session.canceling = false;
  publish(session, true);
}

export function stopAllUploadQueues() {
  shuttingDown = true;
  if (statusTimer !== null) {
    window.clearTimeout(statusTimer);
    statusTimer = null;
  }
  statusAbortController?.abort();
  statusAbortController = null;
  for (const session of sessions.values()) {
    session.canceling = true;
    if (session.retryTimer !== null) window.clearInterval(session.retryTimer);
    session.retryTimer = null;
    if (session.publishTimer !== null)
      window.clearTimeout(session.publishTimer);
    for (const controller of session.activeControllers) controller.abort();
    for (const upload of session.activeTus) void upload.abort(false);
    for (const row of session.rows) {
      if (row.status === 'queued') {
        setStatus(session, row, 'canceled');
        row.file = null;
      }
    }
    session.visible = false;
  }
  sessions.clear();
  nextSessionIndex = 0;
  overview = [];
  for (const listener of overviewListeners) listener();
  if (unloadAttached) {
    window.removeEventListener('beforeunload', warnBeforeUnload);
    unloadAttached = false;
  }
}

export function dismissUploadActivity(boardId: string) {
  const session = sessions.get(boardId);
  if (
    !session ||
    session.activeTasks ||
    session.counts.queued ||
    session.counts.processing
  )
    return;
  session.visible = false;
  session.rows = [];
  session.counts = { ...EMPTY_COUNTS };
  session.nextIndex = 0;
  publish(session, true);
}

export function uploadWorkActive(boardId: string): boolean {
  const session = sessions.get(boardId);
  return Boolean(
    session && (session.activeTasks > 0 || session.counts.queued > 0),
  );
}
