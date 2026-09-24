// Everything a picture's file carries about itself (CONTEXT.md "File
// metadata"): its EXIF, GPS, IPTC and XMP, read once when someone first asks
// and kept in `images.metadata` (0032). Captured properties (worker/
// captured.ts) are the ten a person sorts and finds by; this is the rest,
// shown and never edited, because the file said it and nobody else did.
//
// Read from the camera file when intake kept one (a HEIC or RAW source):
// the JPEG made from it is the original, and may not carry what the camera
// wrote. Binary blobs, thumbnails and maker notes are left out; they are
// bytes, not facts a person reads.
import type { ImageMetadata, MetadataGroup } from '@digsite/shared/api';
import exifr from 'exifr';
import type { ImageRow } from '../access/index.ts';
import { pool } from '../db/pool.ts';
import { storageFromEnv } from '../storage/index.ts';
import { originalKey, sourceKey } from './paths.ts';
import { detectImageType } from './validate.ts';

const GROUPS = ['ifd0', 'exif', 'gps', 'iptc', 'xmp', 'jfif', 'ihdr'] as const;
const MAX_TEXT = 400;
const MAX_FIELDS = 300;

const pad = (n: number) => String(n).padStart(2, '0');

/** A date as the camera wrote it. EXIF carries no zone: exifr reads its
 * text as this process's local time, so reading the local fields back gives
 * the camera's own wall time, where toISOString() would shift it by the
 * server's offset (a 18:04 photograph said 01:04 the next day). */
export function wallTime(d: Date): string | undefined {
  if (Number.isNaN(d.getTime())) return undefined;
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return time === '00:00:00' ? date : `${date} ${time}`;
}

/** A control character other than tab and line breaks: text that is
 * really bytes. By code, since a regex of control characters is itself
 * hard to read and linted out. */
function hasBinary(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if ((c >= 1 && c <= 8) || (c >= 14 && c <= 31)) return true;
  }
  return false;
}

/** A value as a person reads it, or undefined when it is bytes. */
export function readable(v: unknown): MetadataGroup[string] | undefined {
  if (v === null || v === undefined) return undefined;
  if (v instanceof Date) return wallTime(v);
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const clean = v.replace(/\0/g, '').trim();
    if (!clean || hasBinary(clean)) return undefined;
    return clean.length > MAX_TEXT ? `${clean.slice(0, MAX_TEXT)}…` : clean;
  }
  if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return undefined;
  if (Array.isArray(v)) {
    const items = v.map(readable).filter((x) => x !== undefined);
    if (!items.length || items.length > 24) return undefined;
    return items.every((x) => typeof x === 'number')
      ? items.join(', ')
      : items.map(String).join('; ');
  }
  if (typeof v === 'object') {
    // XMP nests; one level is flattened to "key: value" pairs.
    const parts = Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => [k, readable(x)] as const)
      .filter(([, x]) => x !== undefined && typeof x !== 'object')
      .map(([k, x]) => `${k}: ${x}`);
    return parts.length ? parts.join('; ').slice(0, MAX_TEXT) : undefined;
  }
  return undefined;
}

const SKIP = new Set([
  'MakerNote',
  'thumbnail',
  'ThumbnailOffset',
  'ThumbnailLength',
  'PrintIM',
]);

/** exifr's grouped output, as groups of readable fields. */
export function toGroups(
  raw: Record<string, unknown> | undefined,
): ImageMetadata['groups'] {
  const out: ImageMetadata['groups'] = {};
  let fields = 0;
  for (const name of GROUPS) {
    const group = raw?.[name];
    if (!group || typeof group !== 'object') continue;
    const clean: MetadataGroup = {};
    for (const [key, value] of Object.entries(
      group as Record<string, unknown>,
    )) {
      if (SKIP.has(key) || fields >= MAX_FIELDS) continue;
      const r = readable(value);
      if (r === undefined) continue;
      clean[key] = r;
      fields++;
    }
    if (Object.keys(clean).length) out[name] = clean;
  }
  return out;
}

export async function parseMetadata(
  bytes: Uint8Array,
): Promise<ImageMetadata['groups']> {
  try {
    const raw = await exifr.parse(Buffer.from(bytes), {
      tiff: true,
      exif: true,
      gps: true,
      iptc: true,
      xmp: true,
      jfif: true,
      ihdr: true,
      icc: false,
      ifd1: false,
      makerNote: false,
      userComment: true,
      mergeOutput: false,
      translateKeys: true,
      translateValues: true,
      reviveValues: true,
    });
    return toGroups(raw as Record<string, unknown> | undefined);
  } catch {
    return {};
  }
}

export type Kept = { format: string | null; groups: ImageMetadata['groups'] };

/** The file's format and metadata, read and kept on first ask. Null when
 * nothing can be read (a missing picture, a lost original). */
export async function keptMetadata(
  image: ImageRow & { metadata?: unknown },
): Promise<Kept | null> {
  const stored = image.metadata as Kept | null | undefined;
  if (stored && typeof stored === 'object' && 'groups' in stored) return stored;
  if (image.missing) return null;
  const storage = storageFromEnv();
  const original = await storage.get(originalKey(image.board_id, image.sha256));
  const source = image.source_sha256
    ? await storage.get(sourceKey(image.board_id, image.source_sha256))
    : null;
  const bytes = source ?? original;
  if (!bytes) return null;
  const kept: Kept = {
    format: original ? detectImageType(Buffer.from(original)) : null,
    groups: await parseMetadata(bytes),
  };
  await pool.query('UPDATE images SET metadata = $2 WHERE id = $1', [
    image.id,
    kept,
  ]);
  return kept;
}

/** The whole answer: the file's own facts, then what it carries. */
export async function metadataOf(
  image: ImageRow & { metadata?: unknown; uploaded_by_name?: string | null },
): Promise<ImageMetadata> {
  const kept = await keptMetadata(image);
  const derived = image.properties?.derived_from;
  return {
    file: {
      format: kept?.format ?? null,
      bytes: image.bytes === null ? null : Number(image.bytes),
      sha256: image.sha256,
      width: image.width,
      height: image.height,
      uploadedAt: image.uploaded_at.toISOString(),
      uploadedBy: image.uploaded_by_name ?? null,
      source:
        image.source_format && image.source_bytes
          ? { format: image.source_format, bytes: Number(image.source_bytes) }
          : null,
      derivedFrom: typeof derived === 'string' ? derived : null,
    },
    groups: kept?.groups ?? {},
  };
}
