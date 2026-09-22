// The server's snapshot merge, ported from Excalidraw's own rule (see
// ../../../prototype/sheet/server/reconcile.ts): higher version wins, a
// tie breaks to the lower versionNonce so a stale client cannot roll a
// newer save back. The client uses the excalidraw package's own
// reconcileElements for the same rule against live scenes; this is the
// server's copy, over plain data, for the one write path that persists.

export type Versioned = { id: string; version: number; versionNonce: number };

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

  return [...byId.values()].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
}
