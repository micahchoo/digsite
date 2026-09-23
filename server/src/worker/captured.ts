// Captured properties (CONTEXT.md): what the camera wrote into an original,
// read once by the ladder job and merged UNDER the image's own properties —
// a value the uploader or a member set always wins.
//
// `taken` is a date property (YYYY-MM-DD, the shape filter.ts and the
// property-type detector recognise). `taken_at` keeps the camera's local
// time to the second; EXIF carries no zone, so none is invented.
import type { Properties } from '@digsite/shared';
import exifr from 'exifr';

const TAGS = [
  'DateTimeOriginal',
  'Make',
  'Model',
  'LensModel',
  'FocalLength',
  'ISO',
  'FNumber',
  'ExposureTime',
];

type Tags = Partial<Record<string, unknown>> & {
  latitude?: number;
  longitude?: number;
};

const EXIF_TIME = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/;

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\0/g, '').trim();
  return trimmed || null;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Pure: the tags exifr returns, as properties. Absent or malformed tags
 * are left out, never guessed. */
export function fromExif(tags: Tags): Properties {
  const out: Properties = {};
  const time = text(tags.DateTimeOriginal)?.match(EXIF_TIME);
  if (time) {
    const [, y, mo, d, h, mi, s] = time;
    if (y !== '0000') {
      out.taken = `${y}-${mo}-${d}`;
      out.taken_at = `${y}-${mo}-${d}T${h}:${mi}:${s}`;
    }
  }
  const make = text(tags.Make);
  const model = text(tags.Model);
  // Most models already begin with the make ("Canon EOS R5").
  const camera =
    make && model && !model.toLowerCase().startsWith(make.toLowerCase())
      ? `${make} ${model}`
      : (model ?? make);
  if (camera) out.camera = camera;
  const lens = text(tags.LensModel);
  if (lens) out.lens = lens;
  const numbers: [string, unknown][] = [
    ['focal_mm', tags.FocalLength],
    ['iso', tags.ISO],
    ['aperture', tags.FNumber],
    ['exposure_s', tags.ExposureTime],
    ['latitude', tags.latitude],
    ['longitude', tags.longitude],
  ];
  for (const [key, value] of numbers) {
    const n = finite(value);
    if (n !== null) out[key] = n;
  }
  return out;
}

/** Reads the original's EXIF. A file without EXIF, or with EXIF exifr cannot
 * parse, has no captured properties; that is never an upload failure. */
export async function capturedProperties(bytes: Buffer): Promise<Properties> {
  try {
    // reviveValues would turn DateTimeOriginal into a Date in the server's
    // zone; off, it stays the camera's string. GPS needs revival to become
    // decimal degrees, so it is its own call.
    const [tags, gps] = await Promise.all([
      exifr.parse(bytes, {
        pick: TAGS,
        reviveValues: false,
        translateValues: false,
      }),
      exifr.gps(bytes).catch(() => undefined),
    ]);
    return fromExif({ ...(tags ?? {}), ...(gps ?? {}) });
  } catch {
    return {};
  }
}
