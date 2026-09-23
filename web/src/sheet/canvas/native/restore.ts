// Every element that enters the canvas from outside (a saved scene, a
// peer's delta, the server adding a picture) is brought to the full shape
// here, once, at the boundary. The wire is not typed: a scene saved by an
// older canvas, or written by the server or a test stub, can lack a
// structural field, and every reader past this point trusts the type.
// Found 2026-09-23: an element without `groupIds` reached `moveImage`, and
// `groupIds.includes` threw inside Bring here.
//
// A field that is present is kept exactly (sheet-canvas-seam.md: bindings,
// group ids, points and arrowheads survive a read); a missing one gets the
// value a new element would have.
import type { SceneElement } from '../types.ts';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const num = (v: unknown, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

/** The element in full shape, or null when it has no id to be known by. */
export function restoreElement(raw: unknown): SceneElement | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id) return null;
  return {
    ...(raw as Partial<SceneElement>),
    id: raw.id,
    type: typeof raw.type === 'string' ? raw.type : 'rectangle',
    version: num(raw.version, 1),
    versionNonce: num(raw.versionNonce, 0),
    isDeleted: raw.isDeleted === true,
    updated: num(raw.updated, 0),
    x: num(raw.x, 0),
    y: num(raw.y, 0),
    width: num(raw.width, 0),
    height: num(raw.height, 0),
    groupIds: Array.isArray(raw.groupIds)
      ? raw.groupIds.filter((g): g is string => typeof g === 'string')
      : [],
    boundElements: Array.isArray(raw.boundElements)
      ? (raw.boundElements as SceneElement['boundElements'])
      : null,
    startBinding: isRecord(raw.startBinding)
      ? (raw.startBinding as SceneElement['startBinding'])
      : null,
    endBinding: isRecord(raw.endBinding)
      ? (raw.endBinding as SceneElement['endBinding'])
      : null,
    points: Array.isArray(raw.points)
      ? (raw.points as SceneElement['points'])
      : [],
    startArrowhead: (raw.startArrowhead ??
      null) as SceneElement['startArrowhead'],
    endArrowhead: (raw.endArrowhead ?? null) as SceneElement['endArrowhead'],
  };
}

/** Every element of a raw scene that can be known, in full shape. */
export function restoreElements(raw: readonly unknown[]): SceneElement[] {
  return raw.flatMap((el) => {
    const restored = restoreElement(el);
    return restored ? [restored] : [];
  });
}
