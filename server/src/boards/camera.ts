// Phone and camera formats (roadmap item 8): HEIC and RAW become a JPEG
// once, where they enter, so everything after — validation, the ladder,
// previews, embeddings — sees only a format it already reads.
//
// - HEIC: the bundled libvips has libheif without an HEVC decoder, so an
//   iPhone photo fails there. heic-decode is libheif compiled to WASM with
//   libde265, in-process, no system package. The file's largest image is
//   the photo; the first is not always it.
// - RAW: never decoded as a TIFF. libvips reads a NEF's first directory,
//   which is its 160x120 thumbnail, and says nothing. Every camera embeds
//   its own full-size JPEG rendering; this takes the largest baseline or
//   progressive JPEG in the file. Lossless JPEG (SOF3) is a CR2's or DNG's
//   sensor data, not a picture, and is passed over.
//
// Measured 2026-09-23 on the owner's files: 27 HEIC (iPhone and Samsung, up
// to 6120x8160) at 691 ms average, 84 NEF at 6000x4000 in 117 ms.
import decodeHeic from 'heic-decode';
import sharp from 'sharp';
import { env } from '../env.ts';

const HEIC = /\.(heic|heif)$/i;
const RAW =
  /\.(dng|nef|nrw|cr2|cr3|crw|arw|srf|sr2|raf|orf|rw2|pef|srw|x3f|3fr|iiq|erf|kdc|dcr|mrw|raw|rwl)$/i;

export function isCameraFile(name: string): boolean {
  return HEIC.test(name) || RAW.test(name);
}

export type FromCamera =
  | { ok: true; bytes: Uint8Array; format: string }
  | { ok: false; reason: string };

/** The JPEG a phone or camera file becomes, or why it cannot. `format` is
 * the source's, upper-case, as the image's `format` property. */
export async function fromCamera(
  name: string,
  bytes: Uint8Array,
): Promise<FromCamera> {
  const format = (name.slice(name.lastIndexOf('.') + 1) || 'RAW').toUpperCase();
  try {
    if (HEIC.test(name)) return await fromHeic(bytes, format);
    return await fromRaw(bytes, format);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `${format} could not be decoded: ${why}` };
  }
}

async function fromHeic(
  bytes: Uint8Array,
  format: string,
): Promise<FromCamera> {
  const images = await decodeHeic.all({ buffer: bytes });
  try {
    const photo = images.reduce<(typeof images)[number] | undefined>(
      (best, image) =>
        !best || image.width * image.height > best.width * best.height
          ? image
          : best,
      undefined,
    );
    if (!photo) return { ok: false, reason: `${format} holds no image` };
    if (photo.width * photo.height > env.UPLOAD_MAX_PIXELS) {
      return {
        ok: false,
        reason: `image is ${photo.width}x${photo.height}, over the ${env.UPLOAD_MAX_PIXELS} px budget`,
      };
    }
    const { width, height, data } = await photo.decode();
    const jpeg = await sharp(
      Buffer.from(data.buffer, data.byteOffset, data.byteLength),
      { raw: { width, height, channels: 4 }, limitInputPixels: false },
    )
      .jpeg({ quality: 92 })
      .toBuffer();
    return { ok: true, bytes: new Uint8Array(jpeg), format };
  } finally {
    images.dispose();
  }
}

async function fromRaw(bytes: Uint8Array, format: string): Promise<FromCamera> {
  const found = largestJpeg(bytes);
  if (!found) {
    return { ok: false, reason: `${format} carries no full-size JPEG` };
  }
  const jpeg = bytes.subarray(found.start, found.end);
  // The embedded JPEG carries no orientation; the RAW's first directory
  // does. libvips reads that directory for TIFF-based RAWs; RAF and CR3
  // have none to read.
  let orientation: number | undefined;
  try {
    orientation = (await sharp(bytes).metadata()).orientation;
  } catch {
    orientation = undefined;
  }
  return {
    ok: true,
    bytes:
      orientation && orientation !== 1
        ? withOrientation(jpeg, orientation)
        : jpeg.slice(),
    format,
  };
}

/** `jpeg` with an EXIF segment holding only its orientation, placed after
 * the SOI. Nothing is re-encoded: the RAW then arrives as a camera JPEG
 * does, and every decoder here already applies EXIF orientation. */
export function withOrientation(
  jpeg: Uint8Array,
  orientation: number,
): Uint8Array {
  // biome-ignore format: one row per EXIF field
  const app1 = Buffer.from([
    0xff, 0xe1, 0x00, 0x22, // APP1, 34 bytes
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00, // "Exif\0\0"
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // big-endian TIFF, IFD0 at 8
    0x00, 0x01, // one entry
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, // Orientation, SHORT, 1
    0x00, orientation, 0x00, 0x00, // its value
    0x00, 0x00, 0x00, 0x00, // no next IFD
  ]);
  return Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]);
}

const SOI = Buffer.from([0xff, 0xd8, 0xff]);
const EOI = Buffer.from([0xff, 0xd9]);

/** The largest baseline or progressive JPEG anywhere in `bytes`: its byte
 * range and size. Null when there is none. */
export function largestJpeg(
  bytes: Uint8Array,
): { start: number; end: number; width: number; height: number } | null {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let best: ReturnType<typeof largestJpeg> = null;
  for (let at = b.indexOf(SOI); at >= 0; at = b.indexOf(SOI, at + 3)) {
    const frame = frameOf(b, at);
    if (!frame) continue;
    const end = b.indexOf(EOI, frame.scan);
    if (end < 0) continue;
    if (!best || frame.width * frame.height > best.width * best.height) {
      best = {
        start: at,
        end: end + 2,
        width: frame.width,
        height: frame.height,
      };
    }
  }
  return best;
}

/** Walks a JPEG's marker segments from its SOI to the start of the scan.
 * Null unless the frame is SOF0, SOF1 or SOF2 — what a viewer can show. */
function frameOf(
  b: Buffer,
  start: number,
): { width: number; height: number; scan: number } | null {
  let p = start + 2;
  let size: { width: number; height: number } | null = null;
  while (p + 4 <= b.length && b[p] === 0xff) {
    const marker = b[p + 1] as number;
    if (marker === 0xff) {
      p += 1; // fill byte
      continue;
    }
    const length = b.readUInt16BE(p + 2);
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      if (marker > 0xc2 || p + 9 > b.length) return null;
      size = { height: b.readUInt16BE(p + 5), width: b.readUInt16BE(p + 7) };
    }
    if (marker === 0xda) {
      return size && size.width > 0 && size.height > 0
        ? { ...size, scan: p + 2 + length }
        : null;
    }
    p += 2 + length;
  }
  return null;
}
