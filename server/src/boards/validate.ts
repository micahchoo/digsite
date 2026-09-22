// Phase 5 section 2 (docs/phases/5-hardening.md "Abuse limits"): validates
// an upload BEFORE it's decoded — size, real content type (by magic bytes,
// never the client's declared Content-Type/filename), and a pixel budget
// read straight out of each format's own header. Called from both ingest
// paths that produce a permanent file (boards/routes.ts's multipart route,
// boards/tus.ts's onUploadFinish) — the one thing they share besides
// `uploadOne` (upload.ts's own header comment). worker/jobs.ts's decode
// timeout is the other half of this section's upload-validation bullet —
// this file is header-only, no decode.
import { env } from '../env.ts';

export type ImageType = 'png' | 'jpeg' | 'webp' | 'gif' | 'avif';

export type ValidationFailure = {
  ok: false;
  status: 413 | 415;
  reason: string;
};
export type ValidationSuccess = {
  ok: true;
  type: ImageType;
  width: number | null;
  height: number | null;
};
export type ValidationResult = ValidationFailure | ValidationSuccess;

function startsWith(bytes: Uint8Array, offset: number, sig: number[]): boolean {
  if (bytes.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (bytes[offset + i] !== sig[i]) return false;
  }
  return true;
}

function ascii(bytes: Uint8Array, offset: number, len: number): string {
  if (bytes.length < offset + len) return '';
  let s = '';
  for (let i = 0; i < len; i++)
    s += String.fromCharCode(bytes[offset + i] ?? 0);
  return s;
}

function u32be(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] ?? 0) << 24) |
      ((bytes[offset + 1] ?? 0) << 16) |
      ((bytes[offset + 2] ?? 0) << 8) |
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}

function u16be(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function u16le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function u24le(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) |
    ((bytes[offset + 1] ?? 0) << 8) |
    ((bytes[offset + 2] ?? 0) << 16)
  );
}

/** PNG: signature, then the IHDR chunk (always first, always 13 bytes) has
 * width/height as the first two big-endian uint32s of its data. */
function pngDimensions(
  bytes: Uint8Array,
): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  return { width: u32be(bytes, 16), height: u32be(bytes, 20) };
}

/** GIF: the logical screen descriptor immediately follows the 6-byte
 * signature — width then height, little-endian uint16 each. */
function gifDimensions(
  bytes: Uint8Array,
): { width: number; height: number } | null {
  if (bytes.length < 10) return null;
  return { width: u16le(bytes, 6), height: u16le(bytes, 8) };
}

/** JPEG: walk the marker segments from byte 2 looking for a start-of-frame
 * marker (0xC0-0xCF, excluding the DHT/JPG/DAC markers 0xC4/0xC8/0xCC,
 * which share the range but aren't SOF); its segment holds precision(1),
 * height(2 BE), width(2 BE) right after the 2-byte length. */
function jpegDimensions(
  bytes: Uint8Array,
): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = bytes[offset + 1] ?? 0;
    if (
      marker === 0xd8 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd9)
    ) {
      offset += 2; // standalone markers carry no length
      continue;
    }
    const length = u16be(bytes, offset + 2);
    if (length < 2 || offset + 2 + length > bytes.length) return null;
    const isSof =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isSof) {
      if (offset + 9 > bytes.length) return null;
      const height = u16be(bytes, offset + 5);
      const width = u16be(bytes, offset + 7);
      return { width, height };
    }
    if (marker === 0xda) return null; // start of scan: no SOF found before the entropy-coded data
    offset += 2 + length;
  }
  return null;
}

/** WebP: RIFF container, one of three sub-formats at offset 12 — VP8X
 * (extended, explicit canvas size), VP8L (lossless bitstream) or VP8
 * (lossy keyframe header). Each stores dimensions differently; see inline
 * comments (libwebp's own `mux.c`/`vp8l_dec.c`/`vp8_dec.c` headers). */
function webpDimensions(
  bytes: Uint8Array,
): { width: number; height: number } | null {
  if (bytes.length < 30) return null;
  const format = ascii(bytes, 12, 4);
  if (format === 'VP8X') {
    // 4 reserved/flag bytes at 20, then width-1 and height-1 as 24-bit LE.
    const width = u24le(bytes, 24) + 1;
    const height = u24le(bytes, 27) + 1;
    return { width, height };
  }
  if (format === 'VP8L') {
    if (bytes[20] !== 0x2f) return null; // lossless signature byte
    // The 4 bytes after the signature are a little-endian-packed bitfield
    // (14 bits width-1, 14 bits height-1, 4 bits alpha/version) — read as
    // individual bytes and packed by hand rather than u32be, which assumes
    // big-endian.
    const b0 = bytes[21] ?? 0;
    const b1 = bytes[22] ?? 0;
    const b2 = bytes[23] ?? 0;
    const b3 = bytes[24] ?? 0;
    const packed = b0 | (b1 << 8) | (b2 << 16) | (b3 << 24);
    const width = (packed & 0x3fff) + 1;
    const height = ((packed >> 14) & 0x3fff) + 1;
    return { width, height };
  }
  if (format === 'VP8 ') {
    // Frame tag (3 bytes) then the start code 9D 01 2A at offset 23, then
    // width/height as 14-bit little-endian fields (top 2 bits are scale).
    if (!(bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a))
      return null;
    const width = u16le(bytes, 26) & 0x3fff;
    const height = u16le(bytes, 28) & 0x3fff;
    return { width, height };
  }
  return null;
}

/** AVIF: ISOBMFF box walk — `ftyp`'s brand already picked this format, so
 * this only has to find `meta` > `iprp` > `ipco` > `ispe` (image spatial
 * extents: version+flags(4) then width(4 BE), height(4 BE)). Best-effort:
 * a real encoder always writes one, but a walk that doesn't find it
 * returns null rather than throwing — the caller treats "type known,
 * dimensions unknown" as passing the pixel budget check (nothing to
 * compare against), same as every other unparseable-but-type-valid case,
 * so a decoder-supported AVIF the walk can't fully parse still uploads. */
function isobmffChildren(
  bytes: Uint8Array,
  start: number,
  end: number,
): { type: string; start: number; end: number }[] {
  const boxes: { type: string; start: number; end: number }[] = [];
  let offset = start;
  while (offset + 8 <= end) {
    const size = u32be(bytes, offset);
    const type = ascii(bytes, offset + 4, 4);
    const boxEnd = size === 0 ? end : offset + size;
    if (size < 8 || boxEnd > end) break;
    boxes.push({ type, start: offset + 8, end: boxEnd });
    offset = boxEnd;
  }
  return boxes;
}

function avifDimensions(
  bytes: Uint8Array,
): { width: number; height: number } | null {
  const top = isobmffChildren(bytes, 0, bytes.length);
  const meta = top.find((b) => b.type === 'meta');
  if (!meta) return null;
  // `meta`'s content starts with a 4-byte version/flags field before its
  // own child boxes.
  const metaChildren = isobmffChildren(bytes, meta.start + 4, meta.end);
  const iprp = metaChildren.find((b) => b.type === 'iprp');
  if (!iprp) return null;
  const iprpChildren = isobmffChildren(bytes, iprp.start, iprp.end);
  const ipco = iprpChildren.find((b) => b.type === 'ipco');
  if (!ipco) return null;
  const ipcoChildren = isobmffChildren(bytes, ipco.start, ipco.end);
  const ispe = ipcoChildren.find((b) => b.type === 'ispe');
  if (!ispe) return null;
  if (ispe.end - ispe.start < 12) return null;
  return {
    width: u32be(bytes, ispe.start + 4),
    height: u32be(bytes, ispe.start + 8),
  };
}

/** Real type by magic bytes — never the client's declared Content-Type or
 * filename extension, both of which are just labels the client chose. */
export function detectImageType(bytes: Uint8Array): ImageType | null {
  if (startsWith(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return 'png';
  if (startsWith(bytes, 0, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (
    startsWith(bytes, 0, [0x47, 0x49, 0x46, 0x38]) &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return 'gif';
  }
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP')
    return 'webp';
  if (ascii(bytes, 4, 4) === 'ftyp') {
    const brand = ascii(bytes, 8, 4);
    if (brand === 'avif' || brand === 'avis') return 'avif';
    // Compatible-brands list follows the major brand at +8; a file whose
    // major brand is something else (e.g. 'mif1') but lists avif/avis as
    // compatible is still a real AVIF file in practice.
    for (let o = 16; o + 4 <= 32 && o + 4 <= bytes.length; o += 4) {
      const compat = ascii(bytes, o, 4);
      if (compat === 'avif' || compat === 'avis') return 'avif';
    }
  }
  return null;
}

function dimensionsFor(
  type: ImageType,
  bytes: Uint8Array,
): { width: number; height: number } | null {
  if (type === 'png') return pngDimensions(bytes);
  if (type === 'gif') return gifDimensions(bytes);
  if (type === 'jpeg') return jpegDimensions(bytes);
  if (type === 'webp') return webpDimensions(bytes);
  return avifDimensions(bytes);
}

/** The request-time gate: size cap (UPLOAD_MAX_MB), real content type by
 * magic bytes (415 — "unsupported media type" is the honest reading: the
 * server categorically doesn't take this kind of file, decoded or not),
 * pixel budget from the header (UPLOAD_MAX_PIXELS, 413 — this file is,
 * decoded, too large a "payload" for what this server will hold in
 * memory to paint its ladder). Dimensions unreadable from the header
 * (a format-valid file this walk can't fully parse) pass the budget check
 * — the worker's decode timeout (worker/jobs.ts) is the backstop. */
export function validateUpload(bytes: Uint8Array): ValidationResult {
  const maxBytes = env.UPLOAD_MAX_MB * 1024 * 1024;
  if (bytes.length > maxBytes) {
    return {
      ok: false,
      status: 413,
      reason: `file is ${bytes.length} bytes, over the ${env.UPLOAD_MAX_MB}MB cap`,
    };
  }

  const type = detectImageType(bytes);
  if (!type) {
    return { ok: false, status: 415, reason: 'not a recognised image type' };
  }

  const dims = dimensionsFor(type, bytes);
  if (dims) {
    const pixels = dims.width * dims.height;
    if (pixels > env.UPLOAD_MAX_PIXELS) {
      return {
        ok: false,
        status: 413,
        reason: `image is ${dims.width}x${dims.height} (${pixels} px), over the ${env.UPLOAD_MAX_PIXELS} px budget`,
      };
    }
    return { ok: true, type, width: dims.width, height: dims.height };
  }
  return { ok: true, type, width: null, height: null };
}
