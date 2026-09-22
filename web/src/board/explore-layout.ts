// Sheet-from-a-neighbourhood (docs/phases/2-sheet.md section 4): the pure
// arithmetic `server/src/sheets/routes.ts`'s `POST /boards/:id/sheets` uses
// to turn a `CreateSheetRequest.positions` entry (a CENTRE — see that
// route's own comment and shared/src/api.ts's `CreateSheetRequest`) into an
// element's top-left, scaled to fit like the route's own grid fallback
// already does. Extracted here, pure, so `web/stub/server.ts` can match the
// real route exactly instead of re-deriving it, and so the arithmetic itself
// is unit-tested without a server.
export const SHEET_FIT = 256;

/** Never upscales — an image already smaller than `fit` keeps its own
 * pixel size, same as routes.ts's `Math.min(FIT / w, FIT / h, 1)`. */
export function fitScale(
  width: number,
  height: number,
  fit: number = SHEET_FIT,
): number {
  return Math.min(fit / width, fit / height, 1);
}

export interface Point {
  x: number;
  y: number;
}

export interface PlacedRect extends Point {
  width: number;
  height: number;
}

/** `centre` is where the image's MIDDLE should land; the return value is
 * its top-left plus the fit-scaled size the route also needs to build the
 * element. */
export function centreToTopLeft(
  centre: Point,
  width: number,
  height: number,
  fit: number = SHEET_FIT,
): PlacedRect {
  const scale = fitScale(width, height, fit);
  const w = width * scale;
  const h = height * scale;
  return { x: centre.x - w / 2, y: centre.y - h / 2, width: w, height: h };
}
