// How a group's claims become shared meaning (CONTEXT.md "Making sense"):
// terms and their vocabulary, aliases, confidence, and whether two sheets
// agree about a pair. One definition for the server, the stub and the web,
// so a suggestion, a find and an agreement mark can never disagree about
// what a term means.
import type { Direction } from './elements.ts';

export type TermKind = 'label' | 'relation';

export type Confidence = 'confirmed' | 'likely' | 'unverified';
export const CONFIDENCES: readonly Confidence[] = [
  'confirmed',
  'likely',
  'unverified',
];
export function isConfidence(v: unknown): v is Confidence {
  return v === 'confirmed' || v === 'likely' || v === 'unverified';
}

/** One kind's aliases, term -> canonical. Flat: a canonical is never itself
 * an alias, so one lookup always lands. */
export type AliasMap = Readonly<Record<string, string>>;
export type Aliases = { label: AliasMap; relation: AliasMap };
export const NO_ALIASES: Aliases = { label: {}, relation: {} };

/** The form two spellings share when they are the same term typed
 * differently: "Same_Place", "same place " and "same-place". */
export function normalizeTerm(term: string): string {
  return term
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ')
    .trim();
}

export function canonicalOf(term: string, map: AliasMap): string {
  return map[term] ?? term;
}

/** Every term that means `term`: its canonical and all of that canonical's
 * aliases. What a find or a filter must match. */
export function termsMeaning(term: string, map: AliasMap): string[] {
  const canonical = canonicalOf(term, map);
  const out = [canonical];
  for (const [alias, target] of Object.entries(map)) {
    if (target === canonical) out.push(alias);
  }
  return out;
}

/** The map after `term` is declared to mean `canonical`. Keeps the map flat:
 * a canonical that is itself an alias resolves first, and aliases that
 * pointed at `term` follow it. Returns null for a self-alias. */
export function withAlias(
  map: AliasMap,
  term: string,
  canonical: string,
): Record<string, string> | null {
  const target = canonicalOf(canonical, map);
  if (target === term) return null;
  const next: Record<string, string> = {};
  for (const [alias, to] of Object.entries(map)) {
    if (alias === term) continue;
    next[alias] = to === term ? target : to;
  }
  next[term] = target;
  return next;
}

export type VocabularyTerm = {
  /** The canonical term. */
  term: string;
  /** Claims using this term or any of its aliases. */
  count: number;
  aliases: string[];
};
export type Vocabulary = {
  labels: VocabularyTerm[];
  relations: VocabularyTerm[];
};

/** Per-term claim counts folded onto canonical terms, most-used first. */
export function buildVocabulary(
  counts: Iterable<readonly [string, number]>,
  map: AliasMap,
): VocabularyTerm[] {
  const byCanonical = new Map<string, VocabularyTerm>();
  const entry = (term: string) => {
    let e = byCanonical.get(term);
    if (!e) {
      e = { term, count: 0, aliases: [] };
      byCanonical.set(term, e);
    }
    return e;
  };
  for (const [term, count] of counts) {
    if (!term) continue;
    entry(canonicalOf(term, map)).count += count;
  }
  for (const [alias, canonical] of Object.entries(map)) {
    entry(canonical).aliases.push(alias);
  }
  for (const e of byCanonical.values()) e.aliases.sort();
  return [...byCanonical.values()].sort(
    (a, b) => b.count - a.count || a.term.localeCompare(b.term),
  );
}

/** Terms to offer while someone types. Matches the canonical term or any of
 * its aliases; a prefix beats a substring, then more use wins. An empty
 * query offers the most-used terms. */
export function suggestTerms(
  query: string,
  vocabulary: readonly VocabularyTerm[],
  limit = 8,
): VocabularyTerm[] {
  const q = normalizeTerm(query);
  if (!q) return vocabulary.slice(0, limit);
  const scored: { term: VocabularyTerm; score: number }[] = [];
  for (const term of vocabulary) {
    let best = -1;
    for (const spelling of [term.term, ...term.aliases]) {
      const n = normalizeTerm(spelling);
      if (n.startsWith(q)) best = Math.max(best, 2);
      else if (n.includes(q)) best = Math.max(best, 1);
    }
    if (best >= 0) scored.push({ term, score: best });
  }
  return scored
    .sort((a, b) => b.score - a.score || b.term.count - a.term.count)
    .slice(0, limit)
    .map((s) => s.term);
}

/** The existing canonical term a typed term would duplicate: the same term
 * spelled differently, or one of its aliases. Null when it is new or is
 * exactly that canonical term already. */
export function duplicateOf(
  typed: string,
  vocabulary: readonly VocabularyTerm[],
): string | null {
  const n = normalizeTerm(typed);
  if (!n) return null;
  for (const term of vocabulary) {
    if (term.term === typed) return null;
    for (const spelling of [term.term, ...term.aliases]) {
      if (normalizeTerm(spelling) === n) return term.term;
    }
  }
  return null;
}

// -- pairs and agreement --------------------------------------------------

type PairEdge = {
  source: { imageId: string };
  target: { imageId: string };
  direction: Direction;
  relation: string;
};

/** Two images, unordered: the same key whichever end is the source. */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** The edge's direction read from the pair's first image, so two edges
 * drawn in opposite orders compare as the same claim. */
function orientedDirection(edge: PairEdge): Direction {
  if (edge.source.imageId <= edge.target.imageId) return edge.direction;
  if (edge.direction === 'forward') return 'reverse';
  if (edge.direction === 'reverse') return 'forward';
  return edge.direction;
}

export type Agreement = 'agree' | 'disagree' | 'unknown';

/** Whether two edges on the same pair say the same thing. An unnamed edge
 * says nothing yet, so it neither agrees nor disagrees. */
export function agreementOf(
  a: PairEdge,
  b: PairEdge,
  relations: AliasMap,
): Agreement {
  if (!a.relation || !b.relation) return 'unknown';
  if (canonicalOf(a.relation, relations) !== canonicalOf(b.relation, relations))
    return 'disagree';
  const da = orientedDirection(a);
  const db = orientedDirection(b);
  const opposed =
    (da === 'forward' && db === 'reverse') ||
    (da === 'reverse' && db === 'forward');
  return opposed ? 'disagree' : 'agree';
}
