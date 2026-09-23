import { describe, expect, test } from 'bun:test';
import { RemoteSceneBuffer } from './remote-scenes.ts';

function el(
  id: string,
  version: number,
  fields: Record<string, unknown> = {},
): {
  id: string;
  version: number;
  versionNonce: number;
  [key: string]: unknown;
} {
  return { id, version, versionNonce: 100 - version, ...fields };
}

describe('RemoteSceneBuffer', () => {
  test('coalesces scenes that arrive during asset loading without losing independent edits or tombstones', () => {
    const buffer = new RemoteSceneBuffer();
    buffer.enqueue([el('image-a', 1), el('region-a', 1)]);

    // The caller takes the first scene and waits for its image. These updates
    // arrive during that wait and occupy one pending scene, not two queued
    // full-scene payloads.
    const loading = buffer.take();
    buffer.enqueue([el('image-a', 2, { x: 50 }), el('region-a', 2)]);
    buffer.enqueue([
      el('image-a', 2, { x: 50 }),
      el('region-a', 3, { isDeleted: true }),
      el('image-b', 1),
    ]);

    const pending = buffer.take() as ReturnType<typeof el>[];
    expect(loading).toHaveLength(2);
    expect(buffer.take()).toBeNull();
    expect(pending).toHaveLength(3);
    expect(pending.find((e) => e.id === 'image-a')?.x).toBe(50);
    expect(pending.find((e) => e.id === 'image-b')).toBeTruthy();
    expect(pending.find((e) => e.id === 'region-a')).toMatchObject({
      version: 3,
      isDeleted: true,
    });
  });
});
