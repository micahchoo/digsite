// Where a picture lands on a sheet when the server places it: a new sheet's
// pictures, and pictures added to one later. Pure.
//
// Pictures go in a square-ish grid of CELL-unit cells, each fitted inside
// FIT units and centred in its cell. A picture added later starts a new
// grid one cell to the right of everything already there, level with its
// top. Until 2026-09-23 the grid was written out in both routes.
import { fileId, imageGroupId } from '@digsite/shared/sheet/elements';

export const CELL = 320;
export const FIT = 256;

export type Picture = { id: string; width: number; height: number };
type Point = { x: number; y: number };
type Box = { x: number; y: number; width: number; height: number };

/** The image element a sheet shows a board picture with. */
export function imageElement(
  imageId: string,
  box: Box,
  seed: number,
): Record<string, unknown> {
  return {
    id: `el-img-${imageId}`,
    type: 'image',
    ...box,
    angle: 0,
    strokeColor: 'transparent',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 1,
    strokeStyle: 'solid',
    roughness: 0,
    opacity: 100,
    groupIds: [imageGroupId(imageId)],
    frameId: null,
    roundness: null,
    seed,
    version: 1,
    versionNonce: seed,
    isDeleted: false,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
    status: 'saved',
    fileId: fileId(imageId),
    scale: [1, 1],
    customData: { kind: 'image', imageId },
  };
}

/** The picture's own size, shrunk (never grown) to fit inside FIT. */
function fitted(p: Picture): { width: number; height: number } {
  const scale = Math.min(FIT / p.width, FIT / p.height, 1);
  return { width: p.width * scale, height: p.height * scale };
}

/**
 * Image elements for `pictures`, in order, in a grid from `origin`. An
 * explicit centre in `centres` (a ring from shared/sheet/layout.ts, sent
 * by the client) wins for its picture; the size is still the picture's own.
 */
export function placePictures(
  pictures: readonly Picture[],
  origin: Point = { x: 0, y: 0 },
  centres: Readonly<Record<string, Point>> = {},
): Record<string, unknown>[] {
  const cols = Math.max(1, Math.ceil(Math.sqrt(pictures.length)));
  return pictures.map((p, i) => {
    const { width, height } = fitted(p);
    const centre = centres[p.id];
    const x = centre
      ? centre.x - width / 2
      : origin.x + (i % cols) * CELL + (CELL - width) / 2;
    const y = centre
      ? centre.y - height / 2
      : origin.y + Math.floor(i / cols) * CELL + (CELL - height) / 2;
    return imageElement(p.id, { x, y, width, height }, i + 1);
  });
}

/** Where pictures added to a sheet start: a cell right of its pictures,
 * level with the highest; the origin on a sheet with none. */
export function appendOrigin(stored: readonly unknown[]): Point {
  const images = (
    stored as (Box & { customData?: { kind?: string } })[]
  ).filter((e) => e?.customData?.kind === 'image');
  if (images.length === 0) return { x: 0, y: 0 };
  return {
    x: Math.max(...images.map((e) => e.x + e.width)) + CELL,
    y: Math.min(...images.map((e) => e.y)),
  };
}
