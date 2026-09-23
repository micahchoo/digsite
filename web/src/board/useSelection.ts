// The selection model (docs/ux/design.md §4.5/§5.1, docs/phases/6-product.md
// "Selection"): a set of IMAGE IDS, owned by the viewer, per board — never
// ranks (`../../.claude/rules/ladder-slot-vs-rank.md`: "a selection on the
// map is a client overlay"; a rank is only ever a lookup key into it, and a
// rank means a different image once the sort changes). Order is tray/
// selection order (design.md §5.1: "Order is selection order (click/drag/
// action order)... that order becomes a new sheet's initial grid layout").
//
// Every method Board.tsx's UI calls (click, shift+click, ctrl+click, band
// drag, section select, neighbourhood, tray reorder, tray remove, clear,
// invert) goes through ONE of the small set of operations below, which all
// funnel into `commit` — the one place a change is pushed onto the undo
// stack and scheduled for the debounced PUT. `bun run stub` at
// `GET/PUT /boards/:id/selection` is the server contract (widened in
// shared/src/api.ts).
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.ts';

const PUT_DEBOUNCE_MS = 300;

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export interface UseSelectionResult {
  imageIds: string[];
  saveState: SaveState;
  /** Replace the whole selection — click-to-single, Explore's replace,
   * "select this section", "select everything on sheet X", "show on
   * board", "select all" (capped), invert. */
  replace: (ids: string[]) => void;
  /** Union `ids` into the selection, appended in the order given after
   * whatever is already selected — shift+click range, band drag, Explore's
   * "add to selection". */
  add: (ids: string[]) => void;
  /** Toggle one id without touching the rest — Ctrl/Cmd+click, and a plain
   * click when the clicked image is already the SOLE selected one (turns
   * the tray off rather than replacing it with itself). */
  toggle: (id: string) => void;
  /** Remove specific ids — the tray's per-thumbnail ×. */
  remove: (ids: string[]) => void;
  /** Reorder without changing membership — tray drag-to-reorder. */
  reorder: (ids: string[]) => void;
  clear: () => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

export function useSelection(boardId: string): UseSelectionResult {
  const [imageIds, setImageIds] = useState<string[]>([]);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const idsRef = useRef<string[]>([]);
  idsRef.current = imageIds;

  const undoStack = useRef<string[][]>([]);
  const redoStack = useRef<string[][]>([]);
  const [, forceRender] = useState(0);

  const putTimer = useRef<{
    handle: number;
    boardId: string;
    imageIds: string[];
    version: number;
  } | null>(null);
  const mutationVersion = useRef(0);
  const writeVersion = useRef(0);
  const writeQueue = useRef<Promise<void>>(Promise.resolve());

  const enqueueWrite = useCallback(
    (targetBoardId: string, ids: string[], version: number) => {
      const snapshot = [...ids];
      const write = writeQueue.current
        .catch(() => {})
        .then(() =>
          api.putBoardSelection(targetBoardId, { imageIds: snapshot }),
        )
        .then(() => {
          if (version === writeVersion.current) setSaveState('saved');
        })
        .catch(() => {
          if (version === writeVersion.current) setSaveState('error');
        });
      writeQueue.current = write.then(
        () => undefined,
        () => undefined,
      );
      return write;
    },
    [],
  );

  // -- load, on boardId change ------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    writeVersion.current += 1;
    const versionAtLoad = mutationVersion.current;
    undoStack.current = [];
    redoStack.current = [];
    setSaveState('idle');
    // Do not expose the previous board's selection while the new board's
    // saved selection is loading.
    idsRef.current = [];
    setImageIds([]);
    void api
      .getBoardSelection(boardId)
      .then((res) => {
        if (cancelled || mutationVersion.current !== versionAtLoad) return;
        idsRef.current = res.imageIds;
        setImageIds(res.imageIds);
      })
      .catch(() => {
        if (!cancelled && mutationVersion.current === versionAtLoad) {
          idsRef.current = [];
          setImageIds([]);
        }
      });
    return () => {
      cancelled = true;
      // A fast board switch must not discard the last debounced selection
      // write. A hard document reload does not guarantee this React cleanup
      // runs; the tray surfaces the pending save state while it is mounted.
      const pending = putTimer.current;
      if (pending) {
        window.clearTimeout(pending.handle);
        putTimer.current = null;
        void enqueueWrite(pending.boardId, pending.imageIds, pending.version);
      }
    };
  }, [boardId, enqueueWrite]);

  const schedulePut = useCallback(
    (ids: string[]) => {
      const prior = putTimer.current;
      if (prior) window.clearTimeout(prior.handle);
      const version = ++writeVersion.current;
      const pending = { handle: 0, boardId, imageIds: [...ids], version };
      setSaveState('saving');
      pending.handle = window.setTimeout(() => {
        putTimer.current = null;
        void enqueueWrite(pending.boardId, pending.imageIds, pending.version);
      }, PUT_DEBOUNCE_MS);
      putTimer.current = pending;
    },
    [boardId, enqueueWrite],
  );

  // Every mutation funnels here: push the PREVIOUS value for undo, clear
  // redo (a fresh action invalidates whatever was undone), set state,
  // schedule the optimistic PUT.
  const commit = useCallback(
    (next: string[], opts?: { history?: boolean }) => {
      mutationVersion.current += 1;
      if (opts?.history !== false) {
        undoStack.current = [...undoStack.current, idsRef.current];
        redoStack.current = [];
      }
      idsRef.current = next;
      setImageIds(next);
      schedulePut(next);
      forceRender((n) => n + 1);
    },
    [schedulePut],
  );

  const replace = useCallback((ids: string[]) => commit(dedupe(ids)), [commit]);

  const add = useCallback(
    (ids: string[]) => {
      const have = new Set(idsRef.current);
      const appended = ids.filter((id) => !have.has(id));
      if (!appended.length) return;
      commit([...idsRef.current, ...dedupe(appended)]);
    },
    [commit],
  );

  const toggle = useCallback(
    (id: string) => {
      const cur = idsRef.current;
      if (cur.includes(id)) {
        commit(cur.filter((x) => x !== id));
      } else {
        commit([...cur, id]);
      }
    },
    [commit],
  );

  const remove = useCallback(
    (ids: string[]) => {
      const drop = new Set(ids);
      commit(idsRef.current.filter((x) => !drop.has(x)));
    },
    [commit],
  );

  const reorder = useCallback(
    (ids: string[]) => {
      // Reordering must not silently drop or invent membership — keep only
      // ids that were already selected, in the given order, then append
      // anything the caller missed (defensive, should not happen).
      const have = new Set(idsRef.current);
      const known = ids.filter((id) => have.has(id));
      const missing = idsRef.current.filter((id) => !known.includes(id));
      commit([...known, ...missing]);
    },
    [commit],
  );

  const clear = useCallback(() => {
    if (!idsRef.current.length) return;
    commit([]);
  }, [commit]);

  const undo = useCallback(() => {
    const prev = undoStack.current.at(-1);
    if (prev === undefined) return;
    undoStack.current = undoStack.current.slice(0, -1);
    redoStack.current = [...redoStack.current, idsRef.current];
    idsRef.current = prev;
    setImageIds(prev);
    schedulePut(prev);
    forceRender((n) => n + 1);
  }, [schedulePut]);

  const redo = useCallback(() => {
    const next = redoStack.current.at(-1);
    if (next === undefined) return;
    redoStack.current = redoStack.current.slice(0, -1);
    undoStack.current = [...undoStack.current, idsRef.current];
    idsRef.current = next;
    setImageIds(next);
    schedulePut(next);
    forceRender((n) => n + 1);
  }, [schedulePut]);

  return {
    imageIds,
    saveState,
    replace,
    add,
    toggle,
    remove,
    reorder,
    clear,
    undo,
    redo,
    canUndo: undoStack.current.length > 0,
    canRedo: redoStack.current.length > 0,
  };
}

function dedupe(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
