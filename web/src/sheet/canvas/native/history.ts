// Ported from research/image-graph/src/history.ts's `Step`/`Entry` shape —
// "a step is data, not a pair of closures: it names the records it touched
// and holds a copy of each on both sides" — adapted from image-graph's three
// record kinds to our one element array, and from its plain overwrite-on-
// travel to a versioned one: undoing or redoing here must still WIN a sync
// merge (docs/phases/2-sheet.md section 8, "undo/redo restore and bump
// versions so sync carries them"), because `applyRemote` merges by
// `mergeByVersion` (@digsite/shared) and a version that just went backwards
// would lose to whatever a peer already has.
import type { SceneElement } from '../types.ts';

export interface HistoryEntry {
  id: string;
  /** null when the element did not exist before this step — undoing it
   * must turn the element into a tombstone (`isDeleted: true`), never
   * remove it from the array: `mergeByVersion` is additive by id and would
   * otherwise never tell a peer, or the server, that it is gone. */
  before: SceneElement | null;
  after: SceneElement;
}

export interface HistoryStep {
  entries: HistoryEntry[];
}

const DEFAULT_LIMIT = 100;

/** Bounded undo/redo over `HistoryStep`s. Holds no elements of its own
 * beyond what each step's entries carry — `applyStep` is what a caller
 * actually travels with. */
export class History {
  private past: HistoryStep[] = [];
  private future: HistoryStep[] = [];
  constructor(private readonly limit = DEFAULT_LIMIT) {}

  push(step: HistoryStep): void {
    if (!step.entries.length) return;
    this.past.push(step);
    this.future = [];
    while (this.past.length > this.limit) this.past.shift();
  }
  undo(): HistoryStep | null {
    const step = this.past.pop();
    if (!step) return null;
    this.future.push(step);
    return step;
  }
  redo(): HistoryStep | null {
    const step = this.future.pop();
    if (!step) return null;
    this.past.push(step);
    return step;
  }
  get canUndo(): boolean {
    return this.past.length > 0;
  }
  get canRedo(): boolean {
    return this.future.length > 0;
  }
  clear(): void {
    this.past = [];
    this.future = [];
  }
}

function randomVersionNonce(): number {
  return Math.floor(Math.random() * 0x7fffffff);
}

/**
 * Applies `step` onto `current` for undo or redo, bumping every touched
 * element's `version` past whatever it (or the entry's own recorded
 * version) holds, and a fresh `versionNonce` — so the restored content is
 * what wins the next `mergeByVersion` against a peer or the server, exactly
 * as a fresh local edit would. Pure; returns a new array, same length and
 * order as `current` plus any id `current` did not have (a redo bringing
 * back an id `current` never held, e.g. a peer's own history never touched
 * this session's array).
 */
export function applyStep(
  current: readonly SceneElement[],
  step: HistoryStep,
  direction: 'undo' | 'redo',
): SceneElement[] {
  const byId = new Map(current.map((e) => [e.id, e] as const));
  const now = Date.now();
  for (const entry of step.entries) {
    const existing = byId.get(entry.id);
    const baseVersion = Math.max(
      entry.before?.version ?? 0,
      entry.after.version,
      existing?.version ?? 0,
    );
    if (direction === 'undo') {
      const restored: SceneElement = entry.before
        ? { ...entry.before }
        : { ...entry.after, isDeleted: true };
      byId.set(entry.id, {
        ...restored,
        version: baseVersion + 1,
        versionNonce: randomVersionNonce(),
        updated: now,
      });
    } else {
      byId.set(entry.id, {
        ...entry.after,
        version: baseVersion + 1,
        versionNonce: randomVersionNonce(),
        updated: now,
      });
    }
  }
  // Preserve `current`'s array order (paint order), then append any id
  // `current` did not carry at all — a redo bringing back an id from
  // before this array was last rebuilt from a remote snapshot.
  const order = current.map((e) => e.id);
  const seen = new Set(order);
  for (const id of byId.keys()) {
    if (!seen.has(id)) {
      order.push(id);
      seen.add(id);
    }
  }
  return order.map((id) => byId.get(id) as SceneElement);
}
