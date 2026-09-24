// What changed since a kept report (CONTEXT.md "Kept report"): the claims
// the same scope gathers now, against the claims it gathered then, matched
// by claim key. A citation points at the kept one; this says whether it
// still holds. Pure, so the server answers it and a test pins it.
import type { ReportClaim, ReportData } from './data.ts';

/** The parts of a claim a reader would say changed its meaning. Replies
 * count by number: a new word about a claim is news, not a change to it. */
export type ClaimField =
  | 'term'
  | 'direction'
  | 'confidence'
  | 'note'
  | 'properties'
  | 'ends'
  | 'dangling'
  | 'replies';

export type ClaimChange = {
  key: string;
  before: ReportClaim;
  after: ReportClaim;
  fields: ClaimField[];
};

export type ReportChanges = {
  added: ReportClaim[];
  removed: ReportClaim[];
  changed: ClaimChange[];
  /** Claims the same in both. */
  same: number;
};

/** Stable JSON: object keys sorted, so two equal values compare equal
 * whatever order a writer put their keys in. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`,
      )
      .join(',')}}`;
  return JSON.stringify(v);
}

/** Fractions move by float noise when a scene is saved again; a region
 * moved by less than this has not moved. */
const ROUND = 1e-4;
const endsKey = (c: ReportClaim) =>
  stable(
    c.ends.map((e) => ({
      imageId: e.imageId,
      regionKey: e.regionKey,
      label: e.label,
      fraction: e.fraction
        ? Object.fromEntries(
            Object.entries(e.fraction).map(([k, n]) => [
              k,
              Math.round(n / ROUND),
            ]),
          )
        : null,
    })),
  );

export function fieldsChanged(a: ReportClaim, b: ReportClaim): ClaimField[] {
  const out: ClaimField[] = [];
  if (a.term !== b.term) out.push('term');
  if (a.direction !== b.direction) out.push('direction');
  if (a.confidence !== b.confidence) out.push('confidence');
  if (a.note !== b.note) out.push('note');
  if (stable(a.properties) !== stable(b.properties)) out.push('properties');
  if (endsKey(a) !== endsKey(b)) out.push('ends');
  if (a.dangling !== b.dangling) out.push('dangling');
  if (a.replies.length !== b.replies.length) out.push('replies');
  return out;
}

export function reportChanges(
  kept: ReportData,
  now: ReportData,
): ReportChanges {
  const before = new Map(kept.claims.map((c) => [c.key, c]));
  const after = new Map(now.claims.map((c) => [c.key, c]));
  const out: ReportChanges = { added: [], removed: [], changed: [], same: 0 };
  for (const [key, a] of before) {
    const b = after.get(key);
    if (!b) {
      out.removed.push(a);
      continue;
    }
    const fields = fieldsChanged(a, b);
    if (fields.length) out.changed.push({ key, before: a, after: b, fields });
    else out.same++;
  }
  for (const [key, b] of after) if (!before.has(key)) out.added.push(b);
  return out;
}
