// A picture, or one region of it, as a small JPEG data URL: for a report
// that must carry its own pictures (report.ts). The long side is capped, so
// a report of a hundred claims stays a file someone can mail.
import type { Fraction } from '@digsite/shared';

const MAX_SIDE = 520;

/** The crop, or null when the picture cannot be read. */
export async function cropToDataUrl(
  src: string,
  fraction: Fraction | null,
  max = MAX_SIDE,
): Promise<string | null> {
  try {
    const res = await fetch(src, { credentials: 'include' });
    if (!res.ok) return null;
    const bitmap = await createImageBitmap(await res.blob());
    const f = fraction ?? { fx: 0, fy: 0, fw: 1, fh: 1 };
    const sx = f.fx * bitmap.width;
    const sy = f.fy * bitmap.height;
    const sw = Math.max(1, f.fw * bitmap.width);
    const sh = Math.max(1, f.fh * bitmap.height);
    const scale = Math.min(1, max / Math.max(sw, sh));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(sw * scale));
    canvas.height = Math.max(1, Math.round(sh * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return canvas.toDataURL('image/jpeg', 0.85);
  } catch {
    return null;
  }
}
