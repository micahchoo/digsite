// A board's vocabulary on the client (CONTEXT.md "Vocabulary", "Alias"):
// one store per board, shared by every field that suggests terms, so a
// merge made in one panel is what every picker offers next. The server's
// answer lags a sheet's own new terms by one save, so `withLocalTerms`
// folds in what this page has typed but the rows do not hold yet.
import {
  type Aliases,
  type GetBoardVocabularyResponse,
  NO_ALIASES,
  type TermKind,
  type VocabularyTerm,
  canonicalOf,
} from '@digsite/shared';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { api } from './api.ts';

const EMPTY: GetBoardVocabularyResponse = {
  labels: [],
  relations: [],
  aliases: NO_ALIASES,
};

type Entry = {
  data: GetBoardVocabularyResponse;
  listeners: Set<() => void>;
  inflight: Promise<void> | null;
};
const store = new Map<string, Entry>();

function entryOf(boardId: string): Entry {
  let entry = store.get(boardId);
  if (!entry) {
    entry = { data: EMPTY, listeners: new Set(), inflight: null };
    store.set(boardId, entry);
  }
  return entry;
}

function publish(boardId: string, data: GetBoardVocabularyResponse): void {
  const entry = entryOf(boardId);
  entry.data = data;
  for (const listener of entry.listeners) listener();
}

/** Refetches once, however many callers ask at the same moment. */
export function refreshVocabulary(boardId: string): Promise<void> {
  const entry = entryOf(boardId);
  entry.inflight ??= api
    .getVocabulary(boardId)
    .then((data) => publish(boardId, data))
    .catch(() => {
      // Suggestions are a help, never a gate: a failed fetch keeps the
      // last answer and every field still accepts free text.
    })
    .finally(() => {
      entry.inflight = null;
    });
  return entry.inflight;
}

export interface VocabularyApi {
  vocabulary: GetBoardVocabularyResponse;
  refresh: () => void;
  /** `term` now means `canonical`, for everyone on the board. */
  merge: (kind: TermKind, term: string, canonical: string) => Promise<void>;
  /** `term` means itself again. */
  separate: (kind: TermKind, term: string) => Promise<void>;
}

export function useVocabulary(boardId: string | null): VocabularyApi {
  const vocabulary = useSyncExternalStore(
    useCallback(
      (listener: () => void) => {
        if (!boardId) return () => {};
        const entry = entryOf(boardId);
        entry.listeners.add(listener);
        return () => entry.listeners.delete(listener);
      },
      [boardId],
    ),
    () => (boardId ? entryOf(boardId).data : EMPTY),
  );
  useEffect(() => {
    if (boardId) void refreshVocabulary(boardId);
  }, [boardId]);
  const refresh = useCallback(() => {
    if (boardId) void refreshVocabulary(boardId);
  }, [boardId]);
  const merge = useCallback(
    async (kind: TermKind, term: string, canonical: string) => {
      if (!boardId) return;
      await api.putAlias(boardId, { kind, term, canonical });
      await refreshVocabulary(boardId);
    },
    [boardId],
  );
  const separate = useCallback(
    async (kind: TermKind, term: string) => {
      if (!boardId) return;
      await api.deleteAlias(boardId, kind, term);
      await refreshVocabulary(boardId);
    },
    [boardId],
  );
  return { vocabulary, refresh, merge, separate };
}

/** The vocabulary plus terms this page holds that the rows do not yet. */
export function withLocalTerms(
  terms: readonly VocabularyTerm[],
  local: Iterable<string>,
  aliases: Aliases[TermKind],
): VocabularyTerm[] {
  const known = new Set(terms.flatMap((t) => [t.term, ...t.aliases]));
  const extra: VocabularyTerm[] = [];
  for (const term of new Set(local)) {
    if (!term || known.has(term)) continue;
    const canonical = canonicalOf(term, aliases);
    if (known.has(canonical)) continue;
    known.add(term);
    extra.push({ term, count: 1, aliases: [] });
  }
  return extra.length ? [...terms, ...extra] : [...terms];
}
