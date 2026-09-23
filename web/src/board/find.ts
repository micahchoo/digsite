// Find on the board: one question in, one answer out.
//
// A question is words (names and properties, with typed filters and a
// label or relation from the Terms index), meaning (what is in the
// picture), or "more like this" picture. Every way a person changes it is
// an action on `findReducer`, so the rules that were spread over the page —
// a new question starts from the first page of answers, typing leaves "more
// like this", Clear clears everything — are one pure function with tests.
// The answer is an answer in ranks, so it goes through the ranked view
// (ranked-view.ts), and it is shaped only after the view has checked it.
import type {
  FindBoardResponse,
  FindFilterClause,
  MeaningResponse,
  SortableKey,
  TermKind,
} from '@digsite/shared';
import { useMemo, useReducer } from 'react';
import { ApiError, api } from '../lib/api.ts';
import { type RankedView, identity, useRanked } from './ranked-view.ts';

/** A search by meaning asks for this many at a time. */
export const MEANING_PAGE = 24;
/** And shows this many of them as pictures in the Find panel. */
export const MEANING_STRIP = 12;
/** Keystrokes wait this long before a find is asked. */
const TYPING_MS = 250;

export type FindMode = 'words' | 'meaning';

export interface FindQuestion {
  mode: FindMode;
  text: string;
  filters: FindFilterClause[];
  /** A label or relation from the Terms index (CONTEXT.md "Making sense"). */
  claim: { kind: TermKind; term: string } | null;
  /** "More like this": pictures that look like this one, best first. */
  like: { id: string; name: string } | null;
  /** How many a search by meaning asks for. */
  limit: number;
}

export const NO_QUESTION: FindQuestion = {
  mode: 'words',
  text: '',
  filters: [],
  claim: null,
  like: null,
  limit: MEANING_PAGE,
};

export type FindAction =
  | { type: 'text'; text: string }
  | { type: 'mode'; mode: FindMode }
  | { type: 'like'; image: { id: string; name: string } | null }
  | { type: 'claim'; claim: FindQuestion['claim'] }
  | { type: 'filter'; clause: FindFilterClause }
  | { type: 'unfilter'; key: string }
  | { type: 'more' }
  | { type: 'clear' };

export function findReducer(q: FindQuestion, a: FindAction): FindQuestion {
  switch (a.type) {
    // A new question starts from the first page of answers, and typing or
    // choosing a mode leaves "more like this".
    case 'text':
      return { ...q, text: a.text, like: null, limit: MEANING_PAGE };
    case 'mode':
      return { ...q, mode: a.mode, like: null, limit: MEANING_PAGE };
    case 'like':
      return {
        ...q,
        like: a.image,
        text: a.image ? '' : q.text,
        limit: MEANING_PAGE,
      };
    case 'claim':
      return { ...q, claim: a.claim };
    case 'filter':
      return {
        ...q,
        filters: [
          ...q.filters.filter((clause) => clause.key !== a.clause.key),
          a.clause,
        ],
      };
    case 'unfilter':
      return { ...q, filters: q.filters.filter((c) => c.key !== a.key) };
    case 'more':
      return { ...q, limit: q.limit + MEANING_PAGE };
    case 'clear':
      return { ...NO_QUESTION, mode: q.mode };
  }
}

/** By meaning: a search in words of what is in the picture, or "more like". */
export function byMeaning(q: FindQuestion): boolean {
  return q.like !== null || q.mode === 'meaning';
}

/** Whether there is anything to ask. Filters and a claim ask nothing of a
 * search by meaning, which reads only its words or its picture. */
export function isAsked(q: FindQuestion): boolean {
  return byMeaning(q)
    ? q.like !== null || q.text.trim() !== ''
    : q.text.trim() !== '' || q.filters.length > 0 || q.claim !== null;
}

/** Whether the panel shows a result row: anything the person has set. */
export function isSet(q: FindQuestion): boolean {
  return (
    q.text.trim() !== '' ||
    q.filters.length > 0 ||
    q.claim !== null ||
    q.like !== null
  );
}

/** Everything the question's answer depends on, and nothing else: "Show
 * more" asks a words find nothing new, and a claim changes no search by
 * meaning. */
export function questionKey(q: FindQuestion): string {
  if (q.like) return JSON.stringify(['like', q.like.id, q.limit]);
  if (q.mode === 'meaning')
    return JSON.stringify(['meaning', q.text.trim(), q.limit]);
  return JSON.stringify(['words', q.text.trim(), q.filters, q.claim]);
}

export type FindAsker = Pick<
  typeof api,
  'findBoard' | 'searchMeaning' | 'similarImages'
>;

/** The one request a question makes, its reply exactly as the client gave
 * it (ranked-view.ts reads the build off that object). */
export function askFind(
  client: FindAsker,
  boardId: string,
  sortId: string,
  q: FindQuestion,
): Promise<MeaningResponse | FindBoardResponse> {
  if (q.like) return client.similarImages(boardId, sortId, q.like.id, q.limit);
  if (q.mode === 'meaning')
    return client.searchMeaning(boardId, sortId, q.text.trim(), q.limit);
  return client.findBoard(boardId, sortId, q.text.trim(), q.filters, {
    ...(q.claim?.kind === 'label' ? { label: q.claim.term } : {}),
    ...(q.claim?.kind === 'relation' ? { relation: q.claim.term } : {}),
  });
}

export interface FindResult {
  ranks: number[];
  imageIds: string[];
  count: number;
  /** Best first: a search by meaning, drawn stronger at the top. */
  ranked?: boolean;
}

export function shapeFind(
  reply: MeaningResponse | FindBoardResponse,
): FindResult {
  if ('matches' in reply)
    return {
      ranks: reply.matches.map((m) => m.rank),
      imageIds: reply.matches.map((m) => m.imageId),
      count: reply.matches.length,
      ranked: true,
    };
  return reply;
}

/** What a failed find says, in the words a person can act on. */
export function findFailure(err: unknown, meaning: boolean): string {
  if (meaning && err instanceof ApiError) {
    if (err.status === 503) return 'Search by meaning is off on this server.';
    if (err.status === 409)
      return 'This picture has not been read yet. Try again in a minute.';
    if (err.status === 400) return 'That picture is not on this board.';
  }
  return err instanceof Error ? err.message : 'Search failed';
}

/**
 * A property filter from the panel's three fields, or null when it is not
 * one: no property, no value, or a number property given something else.
 */
export function parseFilter(
  sortableKeys: SortableKey[],
  key: string,
  op: FindFilterClause['op'],
  raw: string,
): FindFilterClause | null {
  if (!key || !raw.trim()) return null;
  const property = sortableKeys.find(
    (k) => typeof k.key !== 'string' && k.key.property === key,
  );
  const isNumber =
    property &&
    typeof property.key !== 'string' &&
    property.key.type === 'number';
  if (!isNumber) return { key, op, value: raw.trim() };
  const value = Number(raw);
  return Number.isFinite(value) ? { key, op, value } : null;
}

/**
 * The board's find: the question, how to change it, and its answer under
 * the view's build. `aliases` asks again when a merge changes what a term
 * matches.
 */
export function useFind(
  view: RankedView | null,
  open: boolean,
  aliases: object,
): {
  question: FindQuestion;
  dispatch: (a: FindAction) => void;
  result: FindResult | null;
  error: string;
} {
  const [question, dispatch] = useReducer(findReducer, NO_QUESTION);
  const asked = open && isAsked(question);
  const answer = useRanked(
    view,
    asked ? `${questionKey(question)} ${identity(aliases)}` : null,
    () => askFind(api, view?.boardId ?? '', view?.sortId ?? '', question),
    TYPING_MS,
  );
  const result = useMemo(
    () => (answer?.value ? shapeFind(answer.value) : null),
    [answer],
  );
  return {
    question,
    dispatch,
    result,
    error: answer?.error ? findFailure(answer.error, byMeaning(question)) : '',
  };
}
