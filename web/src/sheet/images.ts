// Loading a sheet's image files for the canvas (docs/phases/2-sheet.md
// section 7's DoD: "Images load from /images/:id/preview... falling back to
// the placeholder on 404"). Pure-ish (fetch aside) and DOM-adjacent
// (`placeholderDataURL` draws on a detached canvas) but not
// Canvas-specific — `CanvasHandle`'s `files` prop takes whatever this
// produces.
import { fileId } from '@digsite/shared';
import { api } from '../lib/api.ts';
import type { CanvasFile } from './canvas/types.ts';

export interface ImageMeta {
  missing: boolean;
  name: string;
}

function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/** A missing image's file (docs/phases/3-groups.md section 4): the preview
 * is gone server-side too (`GET /images/:id/preview` 404s — see
 * ../stub/server.ts), so this is drawn locally instead of fetched, keyed
 * the same as a real file so the scene's existing image element (and its
 * `fileId`) needs no change. */
function placeholderDataURL(name: string): string {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#e9ecef';
    ctx.fillRect(0, 0, 256, 256);
    ctx.strokeStyle = '#adb5bd';
    ctx.lineWidth = 4;
    ctx.strokeRect(4, 4, 248, 248);
    ctx.fillStyle = '#868e96';
    ctx.font = '20px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('missing', 128, 112);
    ctx.font = '13px sans-serif';
    ctx.fillText(name.slice(0, 24), 128, 144);
  }
  return canvas.toDataURL('image/png');
}

/** Fetches every id in `imageIds` from `/images/:id/preview`, falling back
 * to a drawn placeholder for a known-missing image or a 404 (an image
 * deleted after this sheet's own `GET /sheets/:id`, before the socket's
 * snapshot loaded it). Keyed by `fileId(imageId)`, matching the scene's
 * image elements. */
export async function loadImageFiles(
  imageIds: string[],
  meta: Map<string, ImageMeta>,
): Promise<Map<string, CanvasFile>> {
  const entries = await Promise.all(
    imageIds.map(async (imageId): Promise<[string, CanvasFile]> => {
      const known = meta.get(imageId);
      if (!known?.missing) {
        try {
          const res = await fetch(api.previewUrl(imageId), {
            credentials: 'include',
          });
          if (!res.ok) throw new Error(`preview fetch failed: ${res.status}`);
          const blob = await res.blob();
          const dataURL = await blobToDataURL(blob);
          return [
            fileId(imageId),
            {
              id: fileId(imageId),
              dataURL,
              mimeType: blob.type || 'image/png',
            },
          ];
        } catch {
          // fall through to the placeholder below
        }
      }
      return [
        fileId(imageId),
        {
          id: fileId(imageId),
          dataURL: placeholderDataURL(known?.name ?? imageId),
          mimeType: 'image/png',
        },
      ];
    }),
  );
  return new Map(entries);
}
