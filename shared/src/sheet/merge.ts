// The server's snapshot merge: higher version wins, a
// tie breaks to the lower versionNonce so a stale client cannot roll a
// newer save back. The client uses the same rule against live scenes; this is the
// server's copy, over plain data, for the one write path that persists.

export type Versioned = {
  id: string;
  version: number;
  versionNonce: number;
  /** Fractional index: the scene's z-order, and a bound text
   * must sort after its container. Absent on a freshly seeded element. */
  index?: string | null;
};

export function mergeByVersion<T extends Versioned>(
  stored: T[],
  incoming: T[],
): T[] {
  const byId = new Map<string, T>();
  for (const s of stored) byId.set(s.id, s);

  for (const i of incoming) {
    const existing = byId.get(i.id);
    if (!existing) {
      byId.set(i.id, i);
      continue;
    }
    const incomingWins =
      i.version > existing.version ||
      (i.version === existing.version &&
        i.versionNonce < existing.versionNonce);
    if (incomingWins) byId.set(i.id, i);
  }

  // Scene order is the fractional index, not the id: sorting by id once
  // put bound labels before their containers and rendering refused the
  // snapshot on load (2026-09-22). Elements without an index go last.
  return [...byId.values()].sort((a, b) => {
    const ai = a.index ?? null;
    const bi = b.index ?? null;
    if (ai !== null && bi !== null && ai !== bi) return ai < bi ? -1 : 1;
    if (ai === null && bi !== null) return 1;
    if (ai !== null && bi === null) return -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
