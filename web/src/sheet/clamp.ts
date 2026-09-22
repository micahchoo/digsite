// A region's rect against its image's CURRENT rect: null when it is already
// inside (no rewrite needed), the corrected rect when it is not
// (docs/phases/2-sheet.md section 1: "onChange clamps after every grip move
// and rewrites the element only when the clamp changed it — an unchanged
// rewrite bumps `version` and echoes through sync"). Pure, and the piece
// Sheet.tsx's onChange calls per region element.
import {
  type Fraction,
  type Rect,
  clampFraction,
  fromFraction,
  toFraction,
} from '@digsite/shared';

const EPS = 0.01;

function sameRect(a: Rect, b: Rect): boolean {
  return (
    Math.abs(a.x - b.x) < EPS &&
    Math.abs(a.y - b.y) < EPS &&
    Math.abs(a.width - b.width) < EPS &&
    Math.abs(a.height - b.height) < EPS
  );
}

export function clampRegion(region: Rect, image: Rect): Rect | null {
  const frac: Fraction = toFraction(region, image);
  const inBounds =
    frac.fx >= -1e-6 &&
    frac.fy >= -1e-6 &&
    frac.fx + frac.fw <= 1 + 1e-6 &&
    frac.fy + frac.fh <= 1 + 1e-6;
  if (inBounds) return null;
  const clamped = clampFraction(frac);
  const rect = fromFraction(clamped, image);
  return sameRect(rect, region) ? null : rect;
}
