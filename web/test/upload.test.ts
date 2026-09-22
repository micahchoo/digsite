// Pure: the tus-vs-multipart routing decision. No network, no tus-js-client
// instance created — see ../src/board/upload.ts.
import { describe, expect, test } from 'bun:test';
import {
  TUS_THRESHOLD_BYTES,
  chooseUploadMethod,
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
