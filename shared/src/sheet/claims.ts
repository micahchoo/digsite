// The rows a projection produces (CONTEXT.md "Claim", "Projection"): one
// per live region, one per live edge, each tagged with the sheet that
// owns it. This is how the board and other sheets learn a claim exists —
// the board itself never writes one.

import type { Direction, Properties } from './elements.ts';
import type { Fraction } from './fractions.ts';

export type RegionRow = {
  id: string;
  sheetId: string;
  sourceId: string;
  imageId: string;
} & Fraction & {
    label: string;
    properties: Properties;
  };

export type EdgeEnd = { imageId: string; regionSourceId?: string };

export type EdgeRow = {
  id: string;
  sheetId: string;
  sourceId: string;
  source: EdgeEnd;
  target: EdgeEnd;
  direction: Direction;
  relation: string;
  properties: Properties;
};

export type ForeignRegion = RegionRow & { sheetName: string };
export type ForeignEdge = EdgeRow & { sheetName: string };
export type Foreign = { regions: ForeignRegion[]; edges: ForeignEdge[] };

/** A claim's row id: which sheet, which source element, in one string. */
export function claimId(sheetId: string, sourceId: string): string {
  return `${sheetId}:${sourceId}`;
}
