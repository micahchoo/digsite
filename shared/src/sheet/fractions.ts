// A region's fraction is the fact; pixels are derived from the image's
// CURRENT rectangle every time they are drawn (CONTEXT.md "Fraction").
// Ported from ../../../prototype/sheet/client/src/geometry.ts, with the
// product's MIN_FRACTION (0.01, not the prototype's 0.02) and a single
// Fraction object instead of four positional numbers.

export type Rect = { x: number; y: number; width: number; height: number };
export type Fraction = { fx: number; fy: number; fw: number; fh: number };

export const MIN_FRACTION = 0.01;

export function toFraction(region: Rect, image: Rect): Fraction {
  return {
    fx: (region.x - image.x) / image.width,
    fy: (region.y - image.y) / image.height,
    fw: region.width / image.width,
    fh: region.height / image.height,
  };
}

export function fromFraction(f: Fraction, image: Rect): Rect {
  return {
    x: image.x + f.fx * image.width,
    y: image.y + f.fy * image.height,
    width: f.fw * image.width,
    height: f.fh * image.height,
  };
}

export function clampFraction(f: Fraction): Fraction {
  const fw = Math.min(Math.max(f.fw, MIN_FRACTION), 1);
  const fh = Math.min(Math.max(f.fh, MIN_FRACTION), 1);
  const fx = Math.min(Math.max(f.fx, 0), 1 - fw);
  const fy = Math.min(Math.max(f.fy, 0), 1 - fh);
  return { fx, fy, fw, fh };
}
