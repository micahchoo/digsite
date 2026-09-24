// A report's data (CONTEXT.md "Report"): the claims a scope gathers, with
// what each rests on, in one serialisable shape. The server gathers it
// (server/src/reports/gather.ts); everything a reader sees is drawn from
// it: the document (document.ts), the live viewer (web/src/report/), the
// annotation and graph exports (annotation.ts, graph.ts). A kept report
// stores exactly this, so what was cited can be drawn again.
//
// Pictures are NOT in it. They are referenced by image id and identified by
// the SHA-256 of the original, so a reader holding the original can check
// it is the same picture; the file or the link supplies the pixels.
import type { Direction, Properties } from '../sheet/elements.ts';
import type { Fraction } from '../sheet/fractions.ts';
import type { Aliases, Confidence } from '../sheet/sense.ts';

/** Bumped when a field changes meaning. A reader refuses what it does not
 * know rather than misreading it. */
export const REPORT_FORMAT = 'digsite-report/1';

/** What a report gathers (CONTEXT.md "Report scope"). */
export type ReportScope =
  | { kind: 'sheet'; sheetId: string }
  /** Claims chosen on one sheet: the ids are claims, or pictures whose
   * claims come with them. */
  | { kind: 'selection'; sheetId: string; ids: string[] }
  /** The union: every claim on every sheet of the board. */
  | { kind: 'board'; boardId: string }
  /** Every connection whose canonical relation is `relation`. */
  | { kind: 'relation'; boardId: string; relation: string }
  /** The shortest chain of connections between two pictures. */
  | { kind: 'path'; boardId: string; from: string; to: string };

export type ReportPerson = { name: string; at: string };

export type ReportImage = {
  id: string;
  name: string;
  /** In the displayed frame, after the EXIF turn: what fractions are of. */
  width: number;
  height: number;
  /** The original's SHA-256: what makes a citation checkable. */
  sha256: string;
  missing: boolean;
  /** Its own properties over the captured ones, as stored. */
  properties: Properties;
};

export type ReportEnd = {
  imageId: string;
  /** The region's claim key when the end is a region. */
  regionKey: string | null;
  /** The region's canonical label. */
  label: string | null;
  /** Where the region sits in the picture; null for the whole picture. */
  fraction: Fraction | null;
};

export type ReportReply = ReportPerson & { text: string };

export type ReportClaim = {
  /** `claimId(sheetId, elementId)`: unique across the board. */
  key: string;
  sheetId: string;
  /** The element on its sheet: what a link to the claim names. */
  elementId: string;
  kind: 'connection' | 'region';
  /** Canonical, after the board's aliases. */
  term: string;
  /** As typed on the sheet, which the alias may have renamed. */
  typed: string;
  direction: Direction | null;
  confidence: Confidence | null;
  note: string;
  properties: Properties;
  made: ReportPerson | null;
  edited: ReportPerson | null;
  /** Two for a connection, one for a region. */
  ends: ReportEnd[];
  /** Why the claim no longer rests on what it was drawn on; null when it
   * does (CONTEXT.md "Dangling"). */
  dangling: string | null;
  replies: ReportReply[];
};

export type ReportSheet = {
  id: string;
  name: string;
  /** The snapshot the claims were read from. */
  savedAt: string | null;
};

/** A sheet's scene, for a reader who wants the sheet itself. */
export type ReportScene = { sheetId: string; elements: unknown[] };

export type ReportData = {
  format: typeof REPORT_FORMAT;
  /** Set once the report is kept (CONTEXT.md "Kept report"). */
  id: string | null;
  title: string;
  scope: ReportScope;
  board: { id: string; name: string };
  /** Who asked for it, and when it was gathered. */
  by: string;
  at: string;
  /** Where the app lives: every link in the report starts here. */
  origin: string;
  sheets: ReportSheet[];
  /** In reading order: a sheet's, or the board's slots. */
  images: ReportImage[];
  claims: ReportClaim[];
  aliases: Aliases;
  /** Sheet and selection scopes only. */
  scene: ReportScene | null;
  /** Path scope only: the pictures from `from` to `to`, in order. */
  path: string[] | null;
};

export function isReportData(v: unknown): v is ReportData {
  if (!v || typeof v !== 'object') return false;
  const r = v as Partial<ReportData>;
  return (
    r.format === REPORT_FORMAT &&
    typeof r.title === 'string' &&
    Array.isArray(r.images) &&
    Array.isArray(r.claims) &&
    !!r.scope &&
    !!r.board
  );
}

/** A claim's link in the app. */
export function claimLink(data: ReportData, claim: ReportClaim): string {
  return `${data.origin}/s/${claim.sheetId}?claim=${encodeURIComponent(claim.elementId)}`;
}

/** An anchor inside the document: `#c-<n>` for claims, stable for a given
 * report because the key is. */
export function anchorOf(key: string): string {
  return `c-${key.replace(/[^\w-]/g, '_')}`;
}
