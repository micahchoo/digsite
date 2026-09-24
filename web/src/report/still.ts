// Figure 1 of a sheet's report: the sheet as it stood, drawn by the same
// `renderFrame` the live canvas draws with, so the still cannot disagree
// with the sheet (routed lines, region chips, captions, confidence styles).
// It is what a reader without script, or a printer, sees; the viewer puts
// the live sheet in its place.
import { dataOf, fileId } from '@digsite/shared';
import { fitBox } from '../sheet/canvas/native/camera.ts';
import { boundsOf } from '../sheet/canvas/native/geometry.ts';
import { ImageCache } from '../sheet/canvas/native/images.ts';
import { renderFrame } from '../sheet/canvas/native/render.ts';
import { restoreElements } from '../sheet/canvas/native/restore.ts';
import { type Palette, readPalette } from '../theme/palette.ts';

const WIDTH = 1600;
const MIN_HEIGHT = 500;
const MAX_HEIGHT = 1400;

/** The light palette whatever the app's theme: a document is printed and
 * read on paper-white as often as on a screen. */
export function lightPalette(): Palette {
  const root = document.documentElement;
  const had = root.getAttribute('data-theme');
  root.setAttribute('data-theme', 'light');
  try {
    return readPalette(root);
  } finally {
    if (had === null) root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', had);
  }
}

function decoded(cache: ImageCache, pictures: Record<string, string>) {
  return Promise.all(
    Object.entries(pictures).map(
      ([imageId, dataURL]) =>
        new Promise<void>((resolve) =>
          cache.ensure(
            { id: fileId(imageId), dataURL, mimeType: 'image/jpeg' },
            resolve,
          ),
        ),
    ),
  );
}

/** The sheet as a JPEG data URL, or null when it holds nothing to draw. */
export async function stillOf(
  rawElements: readonly unknown[],
  pictures: Record<string, string>,
  captions: ReadonlyMap<string, string>,
  palette: Palette = lightPalette(),
): Promise<string | null> {
  const elements = restoreElements(rawElements).filter((el) => !el.isDeleted);
  const box = boundsOf(elements.filter((el) => dataOf(el)?.kind === 'image'));
  if (!box) return null;
  const height = Math.round(
    Math.min(
      MAX_HEIGHT,
      Math.max(MIN_HEIGHT, (WIDTH * box.height) / box.width),
    ),
  );
  const viewport = fitBox(box, WIDTH, height, {
    scrollX: 0,
    scrollY: 0,
    zoom: 1,
  });
  const images = new ImageCache();
  await decoded(images, pictures);
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  renderFrame({
    ctx,
    width: WIDTH,
    height,
    viewport,
    elements,
    selectedIds: new Set(),
    images,
    captions,
    palette,
  });
  return canvas.toDataURL('image/jpeg', 0.88);
}
