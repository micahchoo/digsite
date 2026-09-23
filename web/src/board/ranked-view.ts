// Every answer the board holds in ranks, under one order build (C3; the
// server's tile-pixels-change-the-build.md, CONTEXT.md "Build token").
//
// A rank means an image only under one build of one sort. So the map may
// never draw find from one build and sections from another. A view is one
// (board, sort). It keeps the build it shows and hands every answer in
// ranks through one rule:
//
// - a reply that names the view's build, or names none, is delivered;
// - when a newer build appears, every answer is cleared and asked again,
//   and the view tells its listeners (the tile and rank caches);
// - a reply that names any other build is dropped and asked again.
//
// Before this, the rule lived in six effects on the board page, each
// keeping it with a lint suppression. A seventh answer that forgot it
// showed stale ranks silently.
import { useEffect, useRef, useState } from 'react';
import { buildOf as apiBuildOf } from '../lib/api.ts';
import { orderVersionOf, subscribeOrderVersion } from '../lib/order-version.ts';

export type Answer<T> =
  | { value: T; error: null }
  | { value: null; error: unknown };

/** How often a reply from an older build is asked for again before the
 * answer is given up as an error: a server cache that lags the database
 * answers from the build before for a moment, never for long. */
const RETRIES = 4;
const RETRY_MS = 250;

interface Entry {
  run(): void;
  clear(): void;
  cancel(): void;
}

export class RankedView {
  private held: string | undefined;
  private readonly entries = new Set<Entry>();
  private readonly moveListeners = new Set<() => void>();
  private stop: (() => void) | null = null;
  private readonly buildOf: (answer: object) => string | undefined;

  constructor(
    readonly boardId: string,
    readonly sortId: string,
    options: { buildOf?: (answer: object) => string | undefined } = {},
  ) {
    this.buildOf = options.buildOf ?? apiBuildOf;
    this.held = orderVersionOf(boardId, sortId);
  }

  /** Listens only once something is asked or watched, so a view made and
   * thrown away (React does, in development) holds no subscription. */
  private listen(): void {
    if (this.stop) return;
    this.held = orderVersionOf(this.boardId, this.sortId) ?? this.held;
    this.stop = subscribeOrderVersion(() => this.noticed());
  }

  /** The build this view shows, once one has been named. */
  get build(): string | undefined {
    return this.held;
  }

  /** Called after a newer build replaced the one shown. */
  onMove(listener: () => void): () => void {
    this.listen();
    this.moveListeners.add(listener);
    return () => this.moveListeners.delete(listener);
  }

  /**
   * Asks `ask` now, or after `delayMs`, and again whenever the build moves.
   * `deliver` receives each answer, and null when a move makes the answer
   * held so far wrong. Returns a function that stops asking.
   *
   * `ask` returns the reply exactly as the api client gave it: the build is
   * recorded against that object, so a value made from it would pass
   * unchecked. Shape the answer after it is delivered.
   */
  answer<T>(
    ask: () => Promise<T>,
    deliver: (answer: Answer<T> | null) => void,
    delayMs = 0,
  ): () => void {
    let generation = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = (gen: number, tries: number) => {
      ask().then(
        (value) => {
          if (gen !== generation) return;
          const build =
            typeof value === 'object' && value !== null
              ? this.buildOf(value)
              : undefined;
          if (build === undefined || build === this.held) {
            deliver({ value, error: null });
          } else if (tries < RETRIES) {
            timer = setTimeout(() => {
              if (gen === generation) attempt(gen, tries + 1);
            }, RETRY_MS);
          } else {
            deliver({
              value: null,
              error: new Error('the map is still catching up; try again'),
            });
          }
        },
        (error: unknown) => {
          if (gen === generation) deliver({ value: null, error });
        },
      );
    };
    this.listen();
    const entry: Entry = {
      run: () => {
        generation++;
        clearTimeout(timer);
        const gen = generation;
        if (delayMs > 0) timer = setTimeout(() => attempt(gen, 0), delayMs);
        else attempt(gen, 0);
      },
      clear: () => deliver(null),
      cancel: () => {
        generation++;
        clearTimeout(timer);
        this.entries.delete(entry);
      },
    };
    this.entries.add(entry);
    entry.run();
    return entry.cancel;
  }

  /** Stops listening for builds and cancels every answer. */
  dispose(): void {
    this.stop?.();
    this.stop = null;
    for (const entry of [...this.entries]) entry.cancel();
    this.moveListeners.clear();
  }

  private noticed(): void {
    const token = orderVersionOf(this.boardId, this.sortId);
    if (!token || token === this.held) return;
    const first = this.held === undefined;
    this.held = token;
    // The first build of a visit is not a move: nothing was held under
    // another one.
    if (first) return;
    for (const listener of this.moveListeners) listener();
    for (const entry of this.entries) {
      entry.clear();
      entry.run();
    }
  }
}

/**
 * One answer in ranks, for a component. `key` names the question: a new
 * key asks again, null asks nothing. The answer held so far stays while a
 * new key is asked, and is cleared when the view (board or sort) changes or
 * the build moves.
 */
export function useRanked<T>(
  view: RankedView | null,
  key: string | null,
  ask: () => Promise<T>,
  delayMs = 0,
): Answer<T> | null {
  const [state, setState] = useState<{
    view: RankedView | null;
    answer: Answer<T> | null;
  }>({ view, answer: null });
  const askRef = useRef(ask);
  askRef.current = ask;

  useEffect(() => {
    if (!view || key === null) {
      setState({ view, answer: null });
      return;
    }
    setState((s) => (s.view === view ? s : { view, answer: null }));
    return view.answer(
      () => askRef.current(),
      (answer) => setState({ view, answer }),
      delayMs,
    );
  }, [view, key, delayMs]);

  return state.view === view ? state.answer : null;
}

const identities = new WeakMap<object, number>();
let nextIdentity = 0;
/** A number for an object's identity, for a question key: an answer asked
 * again whenever the vocabulary object is replaced, say. */
export function identity(o: object): number {
  let n = identities.get(o);
  if (n === undefined) {
    n = ++nextIdentity;
    identities.set(o, n);
  }
  return n;
}
