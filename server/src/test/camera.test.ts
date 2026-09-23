import { describe, expect, test } from 'bun:test';
// boards/camera.ts: a phone or camera file becomes a JPEG where it enters.
// HEIC is decoded (fixtures/split-64x48.heic: HEVC, red left, blue right,
// made with heif-enc); a RAW gives up its largest embedded viewable JPEG,
// never its thumbnail and never its lossless sensor data.
import { join } from 'node:path';
import sharp from 'sharp';
import { fromCamera, largestJpeg } from '../boards/camera.ts';

const FIXTURES = join(import.meta.dir, 'fixtures');

/** A red-left, blue-right JPEG. */
function splitJpeg(width: number, height: number): Promise<Buffer> {
  const half = width / 2;
  return sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${half}" height="${height}" fill="#e00"/><rect x="${half}" width="${half}" height="${height}" fill="#00e"/></svg>`,
    ),
  )
    .jpeg()
    .toBuffer();
}

/** What a lossless JPEG (SOF3) of 4000x3000 looks like to a scan: bigger
 * than any preview, and not something a viewer can show. */
function losslessStream(): Buffer {
  return Buffer.from([
    0xff, 0xd8, 0xff, 0xc3, 0x00, 0x0b, 0x08, 0x0b, 0xb8, 0x0f, 0xa0, 0x01,
    0x01, 0x11, 0x00, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x00,
    0x00, 0x12, 0x34, 0xff, 0xd9,
  ]);
}

/** A stand-in RAW: a TIFF first directory saying "rotate 90", then a
 * thumbnail, the lossless sensor data and the full-size preview. */
async function fakeRaw(): Promise<Buffer> {
  const tiff = await sharp({
    create: { width: 8, height: 8, channels: 3, background: '#000' },
  })
    .withMetadata({ orientation: 6 })
    .tiff()
    .toBuffer();
  return Buffer.concat([
    tiff,
    await splitJpeg(32, 24),
    losslessStream(),
    await splitJpeg(200, 100),
  ]);
}

/** Mean red and blue of a column band, as [red, blue]. */
async function band(jpeg: Uint8Array, left: number, width: number) {
  const { data, info } = await sharp(jpeg)
    .raw()
    .toBuffer({ resolveWithObject: true });
  let red = 0;
  let blue = 0;
  for (let y = 0; y < info.height; y++) {
    for (let x = left; x < left + width; x++) {
      const i = (y * info.width + x) * info.channels;
      red += data[i] as number;
      blue += data[i + 2] as number;
    }
  }
  const n = info.height * width;
  return [red / n, blue / n];
}

describe('camera', () => {
  test('a HEIC becomes a JPEG of the same picture', async () => {
    const heic = new Uint8Array(
      await Bun.file(join(FIXTURES, 'split-64x48.heic')).arrayBuffer(),
    );
    const out = await fromCamera('IMG_0001.HEIC', heic);
    if (!out.ok) throw new Error(out.reason);
    expect(out.format).toBe('HEIC');
    const meta = await sharp(out.bytes).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['jpeg', 64, 48]);
    const [leftRed, leftBlue] = await band(out.bytes, 4, 16);
    const [rightRed, rightBlue] = await band(out.bytes, 44, 16);
    expect(leftRed).toBeGreaterThan(leftBlue ?? 0);
    expect(rightBlue).toBeGreaterThan(rightRed ?? 0);
  });

  test('the largest viewable JPEG wins; a thumbnail and lossless data do not', async () => {
    const found = largestJpeg(await fakeRaw());
    expect(found && [found.width, found.height]).toEqual([200, 100]);
  });

  test('a RAW keeps its orientation without being re-encoded', async () => {
    const raw = await fakeRaw();
    const out = await fromCamera('DSC_0001.NEF', raw);
    if (!out.ok) throw new Error(out.reason);
    expect(out.format).toBe('NEF');
    const meta = await sharp(out.bytes).metadata();
    expect([meta.width, meta.height, meta.orientation]).toEqual([200, 100, 6]);
    // Every decoder here applies EXIF orientation; this is what they see.
    const upright = await sharp(out.bytes).rotate().toBuffer();
    expect(await sharp(upright).metadata()).toMatchObject({
      width: 100,
      height: 200,
    });
    // The preview's own bytes pass through untouched: SOI, the 36-byte
    // EXIF segment, then everything the camera wrote after its SOI.
    const preview = await splitJpeg(200, 100);
    expect(
      Buffer.from(out.bytes)
        .subarray(2 + 36)
        .equals(preview.subarray(2)),
    ).toBe(true);
  });

  test('a file that is not what its name says is refused with a reason', async () => {
    const raw = await fromCamera(
      'DSC_0002.NEF',
      new TextEncoder().encode('raw'),
    );
    expect(raw).toEqual({ ok: false, reason: 'NEF carries no full-size JPEG' });
    const heic = await fromCamera(
      'IMG_2.heic',
      new TextEncoder().encode('heic'),
    );
    expect(heic.ok).toBe(false);
    expect(heic.ok ? '' : heic.reason).toStartWith('HEIC could not be decoded');
  });
});
