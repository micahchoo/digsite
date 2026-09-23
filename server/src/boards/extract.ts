// A region made into a picture of its own (CONTEXT.md "Extract"): the
// crop of an original becomes a new image on the same board, through the
// one ingest path (upload.ts#uploadOne), so the room check, content
// addressing, the ladder, ranks, captured properties and embeddings all
// apply to it exactly as to an upload. image-graph's "extract region".
//
// A region's fractions are in the DISPLAYED frame: the picture as it looks
// after its EXIF orientation. So the crop is `rotate().extract()`, with
// pixels computed from the rotated size (worker/decode.ts does the same
// swap). An original stored capped (over 4096 px, decode.ts) yields a crop
// of the capped copy.
import sharp from 'sharp';
import { env } from '../env.ts';
import { storageFromEnv } from '../storage/index.ts';
import { originalKey } from './paths.ts';
import { type UploadedImage, uploadOne } from './upload.ts';

export type ExtractFraction = {
  fx: number;
  fy: number;
  fw: number;
  fh: number;
};

/** A valid region inside the picture, or null. */
export function parseFraction(v: unknown): ExtractFraction | null {
  if (typeof v !== 'object' || v === null) return null;
  const { fx, fy, fw, fh } = v as Record<string, unknown>;
  const nums = [fx, fy, fw, fh];
  if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n)))
    return null;
  const f = { fx, fy, fw, fh } as ExtractFraction;
  if (f.fw <= 0 || f.fh <= 0 || f.fx < 0 || f.fy < 0) return null;
  if (f.fx >= 1 || f.fy >= 1) return null;
  return f;
}

/** Pixels of a fraction of a `width` x `height` picture: floored corner,
 * at least one pixel, never past the edge. */
export function cropBox(
  f: ExtractFraction,
  width: number,
  height: number,
): { left: number; top: number; width: number; height: number } {
  const left = Math.min(width - 1, Math.floor(f.fx * width));
  const top = Math.min(height - 1, Math.floor(f.fy * height));
  return {
    left,
    top,
    width: Math.max(1, Math.min(width - left, Math.round(f.fw * width))),
    height: Math.max(1, Math.min(height - top, Math.round(f.fh * height))),
  };
}

export type Extracted = UploadedImage & {
  name: string;
  width: number;
  height: number;
};

/** The new image, or null when the original is gone. */
export async function extractRegion(
  image: { id: string; board_id: string; sha256: string; name: string },
  f: ExtractFraction,
  label: string,
  userId: string,
): Promise<Extracted | null> {
  const original = await storageFromEnv().get(
    originalKey(image.board_id, image.sha256),
  );
  if (!original) return null;
  const input = () =>
    sharp(original, { limitInputPixels: env.UPLOAD_MAX_PIXELS });
  const meta = await input().metadata();
  if (!meta.width || !meta.height) return null;
  const turned = (meta.orientation ?? 1) >= 5;
  const box = cropBox(
    f,
    turned ? meta.height : meta.width,
    turned ? meta.width : meta.height,
  );
  // PNG, so nothing is lost a second time.
  const png = await input().rotate().extract(box).png().toBuffer();
  const name = `${label.trim() || 'Region'} · ${image.name}`;
  const uploaded = await uploadOne(
    image.board_id,
    userId,
    name,
    new Uint8Array(png),
    {
      derived_from: image.name,
      derived_region: [f.fx, f.fy, f.fw, f.fh]
        .map((n) => n.toFixed(4))
        .join(','),
    },
    'image/png',
  );
  return { ...uploaded, name, width: box.width, height: box.height };
}
