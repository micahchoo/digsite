// Pure: the tus-vs-multipart routing decision. No network, no tus-js-client
// instance created — see ../src/board/upload.ts.
import { describe, expect, test } from 'bun:test';
import {
  TUS_THRESHOLD_BYTES,
  type UploadRow,
  chooseUploadMethod,
  pollUntilReady,
} from '../src/board/upload.ts';

describe('chooseUploadMethod', () => {
  test('at or under the 8 MB threshold is multipart', () => {
    expect(chooseUploadMethod(0)).toBe('multipart');
    expect(chooseUploadMethod(1024)).toBe('multipart');
    expect(chooseUploadMethod(TUS_THRESHOLD_BYTES)).toBe('multipart');
  });

  test('over the 8 MB threshold is tus', () => {
    expect(chooseUploadMethod(TUS_THRESHOLD_BYTES + 1)).toBe('tus');
    expect(chooseUploadMethod(50 * 1024 * 1024)).toBe('tus');
  });
});

describe('upload status confirmation', () => {
  function pendingRow(): UploadRow {
    return {
      clientId: 'test',
      file: new File(['x'], 'x.png'),
      method: 'multipart',
      status: 'pending',
      progress: 100,
      imageId: 'image-1',
    };
  }

  test('retries a transient status-read failure without losing accepted rows', async () => {
    const row = pendingRow();
    let now = 0;
    let requests = 0;
    const result = await pollUntilReady('board-1', [row], () => {}, {
      timeoutMs: 10,
      intervalMs: 1,
      now: () => now,
      wait: async (ms) => {
        now += ms;
      },
      listImages: async () => {
        requests += 1;
        if (requests === 1) throw new Error('temporary read failure');
        return {
          images: [
            {
              id: 'image-1',
              slot: 1,
              name: 'x.png',
              width: 10,
              height: 10,
              uploadedAt: new Date(0).toISOString(),
              properties: {},
              missing: false,
              status: 'ready',
              error: null,
            },
          ],
        };
      },
    });

    expect(requests).toBe(2);
    expect(row.status).toBe('ready');
    expect(result).toEqual({ timedOut: false, confirmationUnavailable: false });
  });

  test('bounds repeated status-read failures and keeps accepted rows pending', async () => {
    const row = pendingRow();
    let now = 0;
    const result = await pollUntilReady('board-1', [row], () => {}, {
      timeoutMs: 3,
      intervalMs: 1,
      now: () => now,
      wait: async (ms) => {
        now += ms;
      },
      listImages: async () => {
        throw new Error('status service unavailable');
      },
    });

    expect(now).toBe(3);
    expect(row.status).toBe('pending');
    expect(result).toEqual({ timedOut: false, confirmationUnavailable: true });
  });
});
