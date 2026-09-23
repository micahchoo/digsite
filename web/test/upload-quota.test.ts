// A group whose storage is full (413, reason 'quota'): the queue stops like
// it does for a full disk, keeps what the server kept, and says how full.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
  enqueueUploads,
  getUploadSnapshot,
  quotaOf,
} from '../src/board/upload.ts';
import { ApiError, api } from '../src/lib/api.ts';
import { bytesLabel } from '../src/lib/bytes.ts';

const upload = api.uploadImages;
const statuses = api.uploadImageStatuses;
const previousWindow = globalThis.window;

beforeEach(() => {
  Reflect.set(globalThis, 'window', {
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    addEventListener() {},
    removeEventListener() {},
  });
  api.uploadImageStatuses = async (_board, ids) => ({
    images: ids.map((id) => ({ id, status: 'ready', error: null })),
  });
});
afterEach(() => {
  api.uploadImages = upload;
  api.uploadImageStatuses = statuses;
  Reflect.set(globalThis, 'window', previousWindow);
});

async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('upload state did not settle');
    await Bun.sleep(10);
  }
}

const full = (accepted?: { name: string; id: string }[]) =>
  new ApiError(413, 'quota', null, null, {
    error: 'group storage is full',
    reason: 'quota',
    usedBytes: 4_800_000_000,
    quotaBytes: 5_000_000_000,
    ...(accepted ? { accepted } : {}),
  });

const files = (...names: string[]) =>
  names.map((n) => new File(['x'], n, { type: 'image/png' }));

test('a full group keeps what the server kept, fails the rest of the batch and stops the queue', async () => {
  api.uploadImages = async () => {
    throw full([{ name: 'a.png', id: 'kept-1' }]);
  };
  enqueueUploads('quota-board', files('a.png', 'b.png'));
  await until(() => getUploadSnapshot('quota-board').counts.ready === 1);
  const snap = getUploadSnapshot('quota-board');
  expect(snap.rows.map((r) => [r.name, r.status])).toEqual([
    ['a.png', 'ready'],
    ['b.png', 'error'],
  ]);
  expect(snap.message).toContain(
    "this group's storage is full (4.8 GB of 5.0 GB)",
  );
});

test('without the list of what was kept, the rest of the batch is unknown, never failed', async () => {
  api.uploadImages = async () => {
    throw full();
  };
  enqueueUploads('quota-board-2', files('a.png', 'b.png'));
  await until(() => getUploadSnapshot('quota-board-2').counts.unknown === 2);
  expect(getUploadSnapshot('quota-board-2').rows[0]?.error).toContain(
    'Refresh the board',
  );
});

test('a quota refusal is read from the body; any other 413 is not one', () => {
  expect(quotaOf({ reason: 'quota', usedBytes: 1, quotaBytes: 2 })).toEqual({
    usedBytes: 1,
    quotaBytes: 2,
  });
  expect(quotaOf({ error: 'too many files' })).toBeNull();
  expect(quotaOf(null)).toBeNull();
});

test('bytes read as a person reads them', () => {
  expect(bytesLabel(512)).toBe('512 bytes');
  expect(bytesLabel(340_000_000)).toBe('340 MB');
  expect(bytesLabel(1_250_000_000)).toBe('1.3 GB');
});
