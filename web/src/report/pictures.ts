// The pixels a report file carries: each picture once, as a JPEG no longer
// than PICTURE_SIDE on its long side. The sheet's previews are PNGs of up
// to 1024 px (GET /images/:id/preview), which is 1-3 MB for a photograph;
// re-encoded, a picture is a tenth of that, so a full sheet of 150 stays a
// file someone can send. A region's crop is a view of this same copy
// (shared/report/document.ts), so the long side bounds every crop too.
import type { ReportImage } from '@digsite/shared';

export const PICTURE_SIDE = 1024;
const QUALITY = 0.85;
const AT_ONCE = 6;

/** A picture's bytes, or null when it cannot be read. */
export type PictureSource = (imageId: string) => Promise<Blob | null>;

async function toJpeg(blob: Blob): Promise<string | null> {
  const bitmap = await createImageBitmap(blob);
  try {
    const scale = Math.min(
      1,
      PICTURE_SIDE / Math.max(bitmap.width, bitmap.height),
    );
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', QUALITY);
  } finally {
    bitmap.close();
  }
}

/** Every picture a report shows that is still on the board. One that
 * fails is left out; the document says it is not available. */
export async function picturesFor(
  images: readonly ReportImage[],
  source: PictureSource,
  progress?: (done: number, of: number) => void,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const queue = images.filter((img) => !img.missing);
  let done = 0;
  async function worker() {
    for (let img = queue.shift(); img; img = queue.shift()) {
      try {
        const blob = await source(img.id);
        const url = blob ? await toJpeg(blob) : null;
        if (url) out[img.id] = url;
      } catch {
        // Left out: the document draws "picture not available".
      }
      progress?.(++done, images.length);
    }
  }
  await Promise.all(Array.from({ length: AT_ONCE }, worker));
  return out;
}

/** The preview route, with the session. */
export function previewSource(url: (imageId: string) => string): PictureSource {
  return async (imageId) => {
    const res = await fetch(url(imageId), { credentials: 'include' });
    return res.ok ? res.blob() : null;
  };
}
