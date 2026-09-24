// How a report reads (docs/roadmap.md "Report export", R0): connections
// before regions, grouped by canonical term, the biggest group first, and
// inside a group in the reading order of the pictures they rest on. A path
// reads step by step instead. And, for every connection, what the other
// claims on the same pair say (CONTEXT.md "Agreement / disagreement").
//
// Pure, so the document, the viewer and the tests read one order.
import { type Agreement, agreementOf, pairKey } from '../sheet/sense.ts';
import type { ReportClaim, ReportData } from './data.ts';

export type ClaimGroup = {
  kind: 'connection' | 'region';
  /** The canonical term, or '' for claims nobody named. */
  term: string;
  claims: ReportClaim[];
};

/** Where a claim sits in reading order: its ends' pictures, earliest first. */
function positionOf(
  claim: ReportClaim,
  rank: ReadonlyMap<string, number>,
): number[] {
  return claim.ends
    .map((end) => rank.get(end.imageId) ?? Number.MAX_SAFE_INTEGER)
    .sort((a, b) => a - b);
}

function byPosition(rank: ReadonlyMap<string, number>) {
  return (a: ReportClaim, b: ReportClaim): number => {
    const pa = positionOf(a, rank);
    const pb = positionOf(b, rank);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] ?? -1) - (pb[i] ?? -1);
      if (d) return d;
    }
    return a.key.localeCompare(b.key);
  };
}

/** The claims as a reader meets them: groups in order, claims in order. */
export function claimGroups(data: ReportData): ClaimGroup[] {
  const rank = new Map(data.images.map((img, i) => [img.id, i]));
  if (data.path) return pathGroups(data, rank);
  const groups = new Map<string, ClaimGroup>();
  for (const claim of data.claims) {
    const id = `${claim.kind}\u0000${claim.term}`;
    let group = groups.get(id);
    if (!group) {
      group = { kind: claim.kind, term: claim.term, claims: [] };
      groups.set(id, group);
    }
    group.claims.push(claim);
  }
  const order = byPosition(rank);
  for (const group of groups.values()) group.claims.sort(order);
  const kindRank = (g: ClaimGroup) => (g.kind === 'connection' ? 0 : 1);
  return [...groups.values()].sort(
    (a, b) =>
      kindRank(a) - kindRank(b) ||
      Number(!a.term) - Number(!b.term) ||
      b.claims.length - a.claims.length ||
      a.term.localeCompare(b.term),
  );
}

/** A path reads as its steps: one group per pair of neighbours on it. */
function pathGroups(
  data: ReportData,
  rank: ReadonlyMap<string, number>,
): ClaimGroup[] {
  const path = data.path ?? [];
  const names = new Map(data.images.map((img) => [img.id, img.name]));
  const order = byPosition(rank);
  const groups: ClaimGroup[] = [];
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i] as string;
    const b = path[i + 1] as string;
    const key = pairKey(a, b);
    const claims = data.claims
      .filter(
        (c) =>
          c.kind === 'connection' &&
          c.ends.length === 2 &&
          pairKey(c.ends[0]?.imageId ?? '', c.ends[1]?.imageId ?? '') === key,
      )
      .sort(order);
    groups.push({
      kind: 'connection',
      term: `${names.get(a) ?? 'picture'} to ${names.get(b) ?? 'picture'}`,
      claims,
    });
  }
  return groups;
}

/** Every claim in reading order, numbered from 1: the numbers the document
 * prints and the viewer shows. */
export function numbered(groups: readonly ClaimGroup[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const group of groups)
    for (const claim of group.claims)
      if (!out.has(claim.key)) out.set(claim.key, out.size + 1);
  return out;
}

export type Voice = { key: string; sheetId: string; agreement: Agreement };

/** The report's connections by the pair of pictures they join. */
function byPair(data: ReportData): Map<string, ReportClaim[]> {
  const out = new Map<string, ReportClaim[]>();
  for (const claim of data.claims) {
    const [a, b] = claim.ends;
    if (claim.kind !== 'connection' || !a || !b) continue;
    const key = pairKey(a.imageId, b.imageId);
    const list = out.get(key) ?? [];
    list.push(claim);
    out.set(key, list);
  }
  return out;
}

const asPairEdge = (c: ReportClaim) => ({
  source: { imageId: c.ends[0]?.imageId ?? '' },
  target: { imageId: c.ends[1]?.imageId ?? '' },
  direction: c.direction ?? 'none',
  relation: c.term,
});

/** Terms are canonical already, so no alias map is needed. */
const agreement = (a: ReportClaim, b: ReportClaim): Agreement =>
  agreementOf(asPairEdge(a), asPairEdge(b), {});

/** For each connection, the other connections in the report on the same
 * pair of pictures, and whether each agrees with it. Shown, never resolved. */
export function otherVoices(data: ReportData): Map<string, Voice[]> {
  const out = new Map<string, Voice[]>();
  for (const claims of byPair(data).values()) {
    if (claims.length < 2) continue;
    for (const claim of claims) {
      out.set(
        claim.key,
        claims
          .filter((other) => other.key !== claim.key)
          .map((other) => ({
            key: other.key,
            sheetId: other.sheetId,
            agreement: agreement(claim, other),
          })),
      );
    }
  }
  return out;
}

/** How many pairs of pictures the report's claims disagree about. */
export function disagreeingPairs(data: ReportData): number {
  let n = 0;
  for (const claims of byPair(data).values())
    if (
      claims.some((a, i) =>
        claims.slice(i + 1).some((b) => agreement(a, b) === 'disagree'),
      )
    )
      n++;
  return n;
}
