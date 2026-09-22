// Pure fuzzy match for the quick switcher (docs/ux/design.md §3.5):
// substring match scores best (earlier, shorter match wins), an in-order
// subsequence match ("fcs" -> "Faces") still counts but scores lower.
// Returns null for no match at all so a caller can filter with `!== null`.
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;

  const idx = t.indexOf(q);
  if (idx >= 0) {
    // Earlier and tighter (shorter text past the match) scores better;
    // a prefix match is the best of all.
    return 1000 - idx * 5 - (t.length - q.length);
  }

  // Subsequence fallback: every character of q appears in order in t.
  let ti = 0;
  let firstHit = -1;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found === -1) return null;
    if (firstHit === -1) firstHit = found;
    ti = found + 1;
  }
  return 200 - firstHit - (ti - firstHit);
}
