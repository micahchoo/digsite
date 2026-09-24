// What a sheet's scene holds, and every way it changes: the elements, the
// selection, the undo history. No DOM, no React: NativeCanvas.tsx draws it
// and turns pointer and keys into calls on it, and a test holds one bare.
//
// Before 2026-09-23 these lived in NativeCanvas's refs, and the handle's
// methods composed the tested pieces (ops.ts, history.ts, restore.ts) in
// ways nothing tested: that a remote delete drops the selection, that
// `history: false` never enters undo, that a whole drag is one step.
import { mergeByVersion } from '@digsite/shared';
import type { SceneElement, ScenePatch } from '../types.ts';
import { History, applyStep } from './history.ts';
import { applyPatch, diffForHistory, finalizeDrag } from './ops.ts';
import { restoreElements } from './restore.ts';
import { retargetEdges } from './scene.ts';

export type SheetScene = ReturnType<typeof createSheetScene>;

/**
 * `changed` is told after every change the owner must show. A remote
 * update tells it with `remote` set: the owner redraws, and announces
 * nothing back (room.ts re-reads the scene itself).
 */
export function createSheetScene(
  changed: (what: { remote: boolean }) => void = () => {},
) {
  let elements: SceneElement[] = [];
  let selected = new Set<string>();
  const history = new History();

  const live = () =>
    new Set(elements.filter((e) => !e.isDeleted).map((e) => e.id));
  const keepLiveSelection = () => {
    const ids = live();
    selected = new Set([...selected].filter((id) => ids.has(id)));
  };

  return {
    /** Live, including deleted elements inside the tombstone window. */
    elements: (): SceneElement[] => elements,
    selectedIds: (): string[] => [...selected],
    selectedSet: (): ReadonlySet<string> => selected,

    /** Every op in order as one update, and one undo step unless
     * `history` is false. */
    apply(patch: ScenePatch, opts?: { history?: boolean }) {
      const built = retargetEdges(applyPatch(patch, elements));
      if (opts?.history !== false) {
        const entries = diffForHistory(elements, built);
        if (entries.length) history.push({ entries });
      }
      elements = built;
      changed({ remote: false });
    },

    /** A scene from the wire, restored and merged by version. Never enters
     * undo; a selected element it deletes leaves the selection. */
    applyRemote(raw: unknown[]) {
      elements = mergeByVersion(elements, restoreElements(raw));
      keepLiveSelection();
      changed({ remote: true });
    },

    /** Replaces the selection with the live ones among `ids`. */
    select(ids: readonly string[]) {
      const present = live();
      selected = new Set(ids.filter((id) => present.has(id)));
      changed({ remote: false });
    },

    /** A frame of a drag: elements moved or resized, edges following, no
     * undo step yet. */
    preview(next: SceneElement[]) {
      elements = retargetEdges(next);
      changed({ remote: false });
    },

    /** The drag ended: everything it changed since `origin` is one undo
     * step. */
    commitDrag(origin: readonly SceneElement[]) {
      const done = finalizeDrag(origin, elements);
      if (done.entries.length) history.push({ entries: done.entries });
      elements = done.elements;
      changed({ remote: false });
    },

    undo() {
      const step = history.undo();
      if (!step) return;
      elements = applyStep(elements, step, 'undo');
      keepLiveSelection();
      changed({ remote: false });
    },

    redo() {
      const step = history.redo();
      if (!step) return;
      elements = applyStep(elements, step, 'redo');
      keepLiveSelection();
      changed({ remote: false });
    },
  };
}
