// canvas/native/history.ts: bounded undo/redo over per-element entries, and
// the version-bumping `applyStep` needs so a restored state still wins the
// next `mergeByVersion` (@digsite/shared) against a peer or the server —
// docs/phases/2-sheet.md section 8, "undo/redo restore and bump versions so
// sync carries them".
import { describe, expect, test } from 'bun:test';
import { mergeByVersion } from '@digsite/shared';
import { History, applyStep } from '../src/sheet/canvas/native/history.ts';
import type { SceneElement } from '../src/sheet/canvas/types.ts';

function el(
  partial: Partial<SceneElement> & { id: string; version: number },
): SceneElement {
  return {
    type: 'rectangle',
    versionNonce: 1,
    updated: 0,
    isDeleted: false,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    groupIds: [],
    boundElements: null,
    startBinding: null,
    endBinding: null,
    points: [],
    startArrowhead: null,
    endArrowhead: null,
    ...partial,
  };
}

describe('History', () => {
  test('undo pops the last step onto redo; redo pops it back', () => {
    const h = new History();
    const step = {
      entries: [{ id: 'a', before: null, after: el({ id: 'a', version: 1 }) }],
    };
    h.push(step);
    expect(h.canUndo).toBe(true);
    expect(h.canRedo).toBe(false);
    expect(h.undo()).toBe(step);
    expect(h.canUndo).toBe(false);
    expect(h.canRedo).toBe(true);
    expect(h.redo()).toBe(step);
    expect(h.canRedo).toBe(false);
  });

  test('a fresh push forgets the redo branch, as every editor does', () => {
    const h = new History();
    const stepA = {
      entries: [{ id: 'a', before: null, after: el({ id: 'a', version: 1 }) }],
    };
    const stepB = {
      entries: [{ id: 'b', before: null, after: el({ id: 'b', version: 1 }) }],
    };
    h.push(stepA);
    h.undo();
    h.push(stepB);
    expect(h.canRedo).toBe(false);
    expect(h.undo()).toBe(stepB);
  });

  test('a step with no entries is never pushed', () => {
    const h = new History();
    h.push({ entries: [] });
    expect(h.canUndo).toBe(false);
  });

  test('undo/redo past the stack return null and change nothing', () => {
    const h = new History();
    expect(h.undo()).toBeNull();
    expect(h.redo()).toBeNull();
  });

  test('is bounded: pushing past the limit forgets the oldest step', () => {
    const h = new History(2);
    for (const id of ['a', 'b', 'c']) {
      h.push({
        entries: [{ id, before: null, after: el({ id, version: 1 }) }],
      });
    }
    const first = h.undo();
    const second = h.undo();
    expect(h.undo()).toBeNull(); // only 2 kept
    expect([first?.entries[0]?.id, second?.entries[0]?.id].sort()).toEqual([
      'b',
      'c',
    ]);
  });
});

describe('applyStep', () => {
  test('undo restores the recorded content, with a version past what it (or the current element) holds', () => {
    const before = el({ id: 'a', version: 2, x: 10 });
    const after = el({ id: 'a', version: 3, x: 40 });
    const current = [after];
    const step = { entries: [{ id: 'a', before, after }] };
    const restored = applyStep(current, step, 'undo');
    const a = restored.find((e) => e.id === 'a');
    expect(a?.x).toBe(10); // the BEFORE content
    expect(a?.version).toBeGreaterThan(after.version); // wins a version race
    expect(a?.versionNonce).not.toBe(before.versionNonce);
  });

  test('redo reapplies the AFTER content, versioned past current', () => {
    const before = el({ id: 'a', version: 2, x: 10 });
    const after = el({ id: 'a', version: 3, x: 40 });
    const undone = applyStep(
      [after],
      { entries: [{ id: 'a', before, after }] },
      'undo',
    );
    const redone = applyStep(
      undone,
      { entries: [{ id: 'a', before, after }] },
      'redo',
    );
    const a = redone.find((e) => e.id === 'a');
    expect(a?.x).toBe(40);
    expect(a?.version).toBeGreaterThan(
      undone.find((e) => e.id === 'a')?.version ?? 0,
    );
  });

  test('undoing a creation (before: null) tombstones the element rather than removing it — mergeByVersion is additive by id', () => {
    const created = el({ id: 'new-1', version: 1 });
    const current = [created];
    const step = { entries: [{ id: 'new-1', before: null, after: created }] };
    const undone = applyStep(current, step, 'undo');
    expect(undone).toHaveLength(1); // still in the array, as a tombstone
    const tomb = undone.find((e) => e.id === 'new-1');
    expect(tomb?.isDeleted).toBe(true);
    expect(tomb?.version).toBeGreaterThan(created.version);

    // The tombstone must actually win a sync merge against a peer who
    // still has the pre-undo (live) version — the whole point of bumping
    // the version on undo.
    const merged = mergeByVersion([created], undone);
    expect(merged.find((e) => e.id === 'new-1')?.isDeleted).toBe(true);
  });

  test('redoing that creation brings it back, still versioned past the tombstone', () => {
    const created = el({ id: 'new-1', version: 1 });
    const step = { entries: [{ id: 'new-1', before: null, after: created }] };
    const undone = applyStep([created], step, 'undo');
    const redone = applyStep(undone, step, 'redo');
    const back = redone.find((e) => e.id === 'new-1');
    expect(back?.isDeleted).toBe(false);
    expect(back?.version).toBeGreaterThan(
      undone.find((e) => e.id === 'new-1')?.version ?? 0,
    );
  });

  test('preserves array order and appends an id current never held', () => {
    const a = el({ id: 'a', version: 1 });
    const b = el({ id: 'b', version: 1 });
    const step = {
      entries: [{ id: 'c', before: null, after: el({ id: 'c', version: 1 }) }],
    };
    const result = applyStep([a, b], step, 'redo');
    expect(result.map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });
});
