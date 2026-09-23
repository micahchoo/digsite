import { expect, test } from 'bun:test';
import {
  chooseUploadMethod,
  enqueueUploads,
  getUploadOverview,
  getUploadSnapshot,
  stopAllUploadQueues,
  stopQueuedUploads,
} from '../src/board/upload.ts';
import { ApiError, api } from '../src/lib/api.ts';

test('small files use multipart and files over 8MB use resumable transfer', () => {
  expect(chooseUploadMethod(8 * 1024 * 1024)).toBe('multipart');
  expect(chooseUploadMethod(8 * 1024 * 1024 + 1)).toBe('tus');
});

async function until(check: () => boolean) {
  const deadline = Date.now() + 8000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('upload state did not settle');
    await Bun.sleep(10);
  }
}

test('large queues bound transfers, cancel safely during a 429, track accepted IDs and never retry ambiguous writes', async () => {
  const previousWindow = globalThis.window;
  const upload = api.uploadImages;
  const statuses = api.uploadImageStatuses;
  Reflect.set(globalThis, 'window', {
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    addEventListener() {},
    removeEventListener() {},
  });
  type Accepted = Awaited<ReturnType<typeof api.uploadImages>>;
  const held: {
    resolve: (value: Accepted) => void;
    reject: (error: Error) => void;
  }[] = [];
  let calls = 0;
  let active = 0;
  let peak = 0;
  let statusIds: string[] = [];
  let sequence = 0;
  let retryCalls = 0;
  let unknownCalls = 0;
  const acceptedNames: string[] = [];
  const file = new File(['image'], 'test.png', { type: 'image/png' });
  try {
    api.uploadImages = async (boardId, files) => {
      calls++;
      active++;
      peak = Math.max(peak, active);
      try {
        if (boardId === 'held-board') {
          if (files[0]?.name === 'after-stop.png') {
            return [{ id: 'after-stop', slot: 20, status: 'ready' }];
          }
          return await new Promise<Accepted>((resolve, reject) =>
            held.push({ resolve, reject }),
          );
        }
        if (boardId === 'retry-board') {
          retryCalls++;
          if (retryCalls === 1) throw new ApiError(429, 'upload', null, 1);
          acceptedNames.push(...files.map((item) => item.name));
          return files.map(() => ({
            id: `ready-${sequence++}`,
            slot: sequence,
            status: 'ready',
          }));
        }
        unknownCalls++;
        throw new Error('response lost after write');
      } finally {
        active--;
      }
    };
    api.uploadImageStatuses = async (_boardId, ids) => {
      statusIds = [...ids];
      return {
        images: ids.map((id) => ({ id, status: 'ready', error: null })),
      };
    };
    enqueueUploads(
      'held-board',
      Array.from({ length: 20_000 }, () => file),
    );
    expect(calls).toBe(2);
    expect(getUploadSnapshot('held-board').counts.uploading).toBe(20);
    expect(getUploadSnapshot('held-board').counts.queued).toBe(19_980);
    stopQueuedUploads('held-board');
    expect(getUploadSnapshot('held-board').counts.canceled).toBe(19_980);
    expect(getUploadSnapshot('held-board').rows[500]?.file).toBeNull();
    // A fresh selection must not revoke the stop on an older in-flight batch.
    enqueueUploads('held-board', [new File(['x'], 'after-stop.png')]);
    held[0]?.reject(new ApiError(429, 'upload', null, 1));
    held[1]?.resolve(
      Array.from({ length: 10 }, (_, index) => ({
        id: `accepted-${index}`,
        slot: index,
        status: 'pending',
      })),
    );
    await until(() => getUploadSnapshot('held-board').counts.ready === 11);
    expect(calls).toBe(3);
    expect(getUploadSnapshot('held-board').counts.queued).toBe(0);
    expect(getUploadSnapshot('held-board').counts.canceled).toBe(19_990);
    expect(statusIds).toEqual(
      Array.from({ length: 10 }, (_, index) => `accepted-${index}`),
    );
    expect(
      getUploadSnapshot('held-board').rows.every((row) => row.file === null),
    ).toBe(true);

    const retryFiles = Array.from(
      { length: 25 },
      (_, index) => new File(['x'], `retry-${index}.png`),
    );
    enqueueUploads('retry-board', retryFiles);
    await until(() => getUploadSnapshot('retry-board').counts.ready === 25);
    expect(retryCalls).toBe(4); // one rejected request plus three accepted batches
    expect(new Set(acceptedNames).size).toBe(25);
    expect(acceptedNames.length).toBe(25);
    expect(peak).toBeLessThanOrEqual(2);

    enqueueUploads('unknown-board', [file]);
    await until(() => getUploadSnapshot('unknown-board').counts.unknown === 1);
    await Bun.sleep(100);
    expect(unknownCalls).toBe(1);
    expect(getUploadSnapshot('unknown-board').counts.failed).toBe(0);
    expect(getUploadSnapshot('unknown-board').rows[0]?.error).toContain(
      'confirm',
    );
    stopAllUploadQueues();
    expect(getUploadOverview()).toEqual([]);
  } finally {
    stopAllUploadQueues();
    api.uploadImages = upload;
    api.uploadImageStatuses = statuses;
    if (previousWindow === undefined)
      Reflect.deleteProperty(globalThis, 'window');
    else Reflect.set(globalThis, 'window', previousWindow);
  }
}, 15_000);
