// Every element in a sheet scene carries customData.kind —
// image, region or edge (CONTEXT.md "Element"). dataOf is the one place
// that trusts that shape; nothing else in the app reads customData raw.

import type { PropertyValue } from '../board/sort.ts';
import { type Confidence, isConfidence } from './sense.ts';

export const SHEET_LIMIT = 150; // image-graph's EXPLORE_LIMIT, carried

export type Direction = 'none' | 'forward' | 'reverse' | 'both';
export type Properties = Record<string, PropertyValue>;

export type ImageData = { kind: 'image'; imageId: string };
export type RegionData = {
  kind: 'region';
  imageId: string;
  label: string;
  properties: Properties;
};
export type EdgeData = {
  kind: 'edge';
  relation: string;
  direction: Direction;
  properties: Properties;
  /** Absent in scenes saved before confidence existed, and when nobody said. */
  confidence?: Confidence;
  /** Why the connection holds. Absent reads as ''. */
  note?: string;
};
export type ElementData = ImageData | RegionData | EdgeData;

export function imageGroupId(imageId: string): string {
  return `g-img-${imageId}`;
}

export function fileId(imageId: string): string {
  return `img-${imageId}`;
}

export function arrowheadsFor(d: Direction): {
  startArrowhead: 'arrow' | null;
  endArrowhead: 'arrow' | null;
} {
  return {
    startArrowhead: d === 'reverse' || d === 'both' ? 'arrow' : null,
    endArrowhead: d === 'forward' || d === 'both' ? 'arrow' : null,
  };
}

/** The inverse of arrowheadsFor: what direction produced this pair. */
export function directionOf(start: unknown, end: unknown): Direction {
  const s = start === 'arrow';
  const e = end === 'arrow';
  if (s && e) return 'both';
  if (e) return 'forward';
  if (s) return 'reverse';
  return 'none';
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isDirection(v: unknown): v is Direction {
  return v === 'none' || v === 'forward' || v === 'reverse' || v === 'both';
}

function isProperties(v: unknown): v is Properties {
  if (!isRecord(v)) return false;
  return Object.values(v).every(
    (x) =>
      typeof x === 'string' ||
      typeof x === 'number' ||
      typeof x === 'boolean' ||
      (Array.isArray(x) &&
        x.every(
          (item) =>
            typeof item === 'string' ||
            typeof item === 'number' ||
            typeof item === 'boolean',
        )),
  );
}

/** Validates customData's shape; a malformed or foreign element is null. */
export function dataOf(el: { customData?: unknown }): ElementData | null {
  const d = el.customData;
  if (!isRecord(d)) return null;

  if (d.kind === 'image') {
    if (typeof d.imageId !== 'string') return null;
    return { kind: 'image', imageId: d.imageId };
  }

  if (d.kind === 'region') {
    if (typeof d.imageId !== 'string') return null;
    if (typeof d.label !== 'string') return null;
    if (!isProperties(d.properties)) return null;
    return {
      kind: 'region',
      imageId: d.imageId,
      label: d.label,
      properties: d.properties,
    };
  }

  if (d.kind === 'edge') {
    if (typeof d.relation !== 'string') return null;
    if (!isDirection(d.direction)) return null;
    if (!isProperties(d.properties)) return null;
    if (d.confidence !== undefined && !isConfidence(d.confidence)) return null;
    if (d.note !== undefined && typeof d.note !== 'string') return null;
    return {
      kind: 'edge',
      relation: d.relation,
      direction: d.direction,
      properties: d.properties,
      ...(d.confidence ? { confidence: d.confidence } : {}),
      ...(d.note ? { note: d.note } : {}),
    };
  }

  return null;
}
