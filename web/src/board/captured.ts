// What the camera wrote into a picture (CONTEXT.md "Captured properties",
// server/src/worker/captured.ts), said the way a person reads it. They stay
// ordinary properties, editable and sortable; this only decides how the
// details panel shows them: one line for the camera, one for the time, and
// the place.
import type { Properties, PropertyValue } from '@digsite/shared';

export const CAPTURED_KEYS = [
  'taken',
  'taken_at',
  'camera',
  'lens',
  'focal_mm',
  'aperture',
  'exposure_s',
  'iso',
  'latitude',
  'longitude',
] as const;

const CAPTURED = new Set<string>(CAPTURED_KEYS);

export function isCaptured(key: string): boolean {
  return CAPTURED.has(key);
}

export interface Captured {
  /** "Canon EOS R5 · RF 35mm · 35 mm · f/2.8 · 1/250 s · ISO 400" */
  camera: string | null;
  /** "12 Mar 2021, 14:03:22" — the camera's local time, no zone. */
  taken: string | null;
  place: { latitude: number; longitude: number } | null;
}

const num = (v: PropertyValue | undefined): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
const str = (v: PropertyValue | undefined): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null;

/** A shutter time as a photographer writes it: 1/250 s, 0.5 s, 2 s. */
export function exposure(seconds: number): string {
  if (seconds > 0 && seconds < 0.5) return `1/${Math.round(1 / seconds)} s`;
  return `${Number(seconds.toFixed(1))} s`;
}

/** The camera line, the time and the place, or null for each one the
 * picture does not carry. */
export function captured(properties: Properties): Captured {
  const parts = [
    str(properties.camera),
    str(properties.lens),
    num(properties.focal_mm) !== null ? `${num(properties.focal_mm)} mm` : null,
    num(properties.aperture) !== null ? `f/${num(properties.aperture)}` : null,
    num(properties.exposure_s) !== null
      ? exposure(num(properties.exposure_s) as number)
      : null,
    num(properties.iso) !== null ? `ISO ${num(properties.iso)}` : null,
  ].filter((part): part is string => part !== null);

  const at = str(properties.taken_at) ?? str(properties.taken);
  let taken: string | null = null;
  if (at) {
    // Read as local time on purpose: EXIF carries no zone, and none is added.
    const [date, time] = at.split('T');
    const [y, m, d] = (date ?? '').split('-').map(Number);
    if (y && m && d) {
      const day = new Date(y, m - 1, d).toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      });
      taken = time ? `${day}, ${time}` : day;
    }
  }

  const latitude = num(properties.latitude);
  const longitude = num(properties.longitude);
  return {
    camera: parts.length ? parts.join(' · ') : null,
    taken,
    place:
      latitude !== null && longitude !== null ? { latitude, longitude } : null,
  };
}
