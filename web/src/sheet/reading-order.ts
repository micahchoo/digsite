// The keyboard annotation loop (CONTEXT.md "Making sense"): with the Region
// tool, Tab moves to the next image and Shift+Tab to the previous one, so a
// set of pictures is annotated without the mouse leaving the work. "Next"
// is reading order: rows top to bottom, then left to right, with images
// whose tops are within half a height of each other counted as one row.
import { dataOf } from '@digsite/shared';
import type { ElementLike } from './overlay/screen.ts';

function imagesInReadingOrder(elements: readonly ElementLike[]): ElementLike[] {
  const images = elements.filter(
    (el) => !el.isDeleted && dataOf(el)?.kind === 'image',
  );
  const byTop = [...images].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: ElementLike[][] = [];
  for (const img of byTop) {
    const row = rows.at(-1);
    const first = row?.[0];
    if (row && first && img.y - first.y < first.height / 2) row.push(img);
    else rows.push([img]);
  }
  return rows.flatMap((row) => row.sort((a, b) => a.x - b.x));
}

/** The image after (`step` 1) or before (-1) `currentId` in reading order,
 * wrapping at the ends. With no current image, the first (or last). */
export function nextImage(
  elements: readonly ElementLike[],
  currentId: string | null,
  step: 1 | -1,
): ElementLike | null {
  const order = imagesInReadingOrder(elements);
  if (!order.length) return null;
  const at = currentId ? order.findIndex((el) => el.id === currentId) : -1;
  if (at < 0) return (step === 1 ? order[0] : order.at(-1)) ?? null;
  return order[(at + step + order.length) % order.length] ?? null;
}
