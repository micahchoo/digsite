import { describe, expect, test } from 'bun:test';
// worker/decode.ts and worker/captured.ts: what the ladder job reads from
// an original, without the queue or storage.
import type { ImageData } from '@napi-rs/canvas';
import sharp from 'sharp';
import { capturedProperties, fromExif } from '../worker/captured.ts';
import { DecodeError, MAX_SIDE, decodeOriginal } from '../worker/decode.ts';

function solid(width: number, height: number) {
  return sharp({
    create: { width, height, channels: 3, background: '#c33' },
  });
}

function pixel(cell: ImageData, x: number, y: number): number[] {
  const i = (y * cell.width + x) * 4;
  return [...cell.data.subarray(i, i + 4)];
}

/** The fill colour, within JPEG's rounding. */
function expectRed([r, g, b, a]: number[]) {
  for (const [got, want] of [
    [r, 0xcc],
    [g, 0x33],
    [b, 0x33],
  ] as const)
    expect(Math.abs((got ?? 0) - want)).toBeLessThanOrEqual(3);
  expect(a).toBe(255);
}

describe('decodeOriginal', () => {
  test('a JPEG gives its size and a cell no larger than 128', async () => {
    const decoded = await decodeOriginal(
      await solid(640, 480).jpeg().toBuffer(),
    );
    expect([decoded.width, decoded.height]).toEqual([640, 480]);
    expect(decoded.capped).toBeNull();
    // 640x480 contained in 128x128: rows 16..111 are picture, the rest #222.
    expect(pixel(decoded.cells[128], 64, 8)).toEqual([0x22, 0x22, 0x22, 255]);
    expectRed(pixel(decoded.cells[128], 64, 64));
  });

  test('EXIF orientation turns the size', async () => {
    const turned = await solid(200, 100)
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const decoded = await decodeOriginal(turned);
    expect([decoded.width, decoded.height]).toEqual([100, 200]);
    // Now portrait: columns 32..95 are picture, the rest #222.
    expect(pixel(decoded.cells[128], 8, 64)).toEqual([0x22, 0x22, 0x22, 255]);
    expectRed(pixel(decoded.cells[128], 64, 64));
  });

  test('an original past MAX_SIDE is capped', async () => {
    const decoded = await decodeOriginal(
      await solid(MAX_SIDE * 2, 100)
        .png()
        .toBuffer(),
    );
    expect([decoded.width, decoded.height]).toEqual([MAX_SIDE, 50]);
    expect(decoded.capped).not.toBeNull();
  });

  test('bytes that are not an image are a DecodeError', async () => {
    await expect(
      decodeOriginal(Buffer.from('not an image at all')),
    ).rejects.toBeInstanceOf(DecodeError);
  });
});

describe('captured properties', () => {
  test('tags become typed properties', () => {
    expect(
      fromExif({
        DateTimeOriginal: '2024:06:01 18:04:59',
        Make: 'Canon',
        Model: 'Canon EOS R5',
        LensModel: 'RF24-105mm F4 L IS USM',
        FocalLength: 35,
        ISO: 400,
        FNumber: 4,
        ExposureTime: 0.004,
        latitude: 50.2996,
        longitude: -4.1,
      }),
    ).toEqual({
      taken: '2024-06-01',
      taken_at: '2024-06-01T18:04:59',
      camera: 'Canon EOS R5',
      lens: 'RF24-105mm F4 L IS USM',
      focal_mm: 35,
      iso: 400,
      aperture: 4,
      exposure_s: 0.004,
      latitude: 50.2996,
      longitude: -4.1,
    });
  });

  test('a model without its make gets the make', () => {
    expect(fromExif({ Make: 'FUJIFILM', Model: 'X-T4' }).camera).toBe(
      'FUJIFILM X-T4',
    );
  });

  test('malformed or empty tags are left out', () => {
    expect(
      fromExif({
        DateTimeOriginal: '0000:00:00 00:00:00',
        Make: '\0\0',
        FocalLength: Number.NaN,
        ISO: 'high',
      }),
    ).toEqual({});
  });

  test('EXIF written into a real JPEG is read back', async () => {
    const jpeg = await solid(64, 64)
      .jpeg()
      .withExif({
        IFD0: { Make: 'Canon', Model: 'Canon EOS R5' },
        IFD2: { DateTimeOriginal: '2024:06:01 18:04:59' },
      })
      .toBuffer();
    const captured = await capturedProperties(jpeg);
    expect(captured.camera).toBe('Canon EOS R5');
    expect(captured.taken).toBe('2024-06-01');
  });

  test('a file without EXIF has none', async () => {
    expect(
      await capturedProperties(await solid(8, 8).png().toBuffer()),
    ).toEqual({});
  });
});
