// canvas/native/sheet-scene.ts: the sheet's elements, selection and undo
// history as one model, asked the questions NativeCanvas's handle used to
// answer by composing the tested pieces untested.
import { describe, expect, test } from 'bun:test';
import { createSheetScene } from '../src/sheet/canvas/native/sheet-scene.ts';

/** A picture element as it comes off the wire. */
function picture(id: string, x = 0, version = 1) {
  return {
    id,
    type: 'image',
    x,
    y: 0,
    width: 100,
    height: 100,
    version,
    versionNonce: 1,
    isDeleted: false,
    groupIds: [`g-${id}`],
    customData: { kind: 'image', imageId: id },
  };
}

function seeded() {
  const told: boolean[] = [];
  const scene = createSheetScene(({ remote }) => told.push(remote));
  scene.applyRemote([picture('a'), picture('b', 200)]);
  told.length = 0;
  return { scene, told };
}

const xOf = (scene: ReturnType<typeof createSheetScene>, id: string) =>
  scene.elements().find((e) => e.id === id)?.x;

describe('the sheet scene', () => {
  test('a remote delete of a selected element takes it out of the selection', () => {
    const { scene } = seeded();
    scene.select(['a', 'b']);
    scene.applyRemote([{ ...picture('a', 0, 2), isDeleted: true }]);
    expect(scene.selectedIds()).toEqual(['b']);
  });

  test('a remote change is told as remote, and never enters undo', () => {
    const { scene, told } = seeded();
    scene.applyRemote([picture('a', 50, 2)]);
    expect(told).toEqual([true]);
    scene.undo();
    expect(xOf(scene, 'a')).toBe(50);
  });

  test('an update without history cannot be undone; one with it can', () => {
    const { scene } = seeded();
    scene.apply([{ op: 'update', id: 'a', changes: { x: 10 } }], {
      history: false,
    });
    scene.undo();
    expect(xOf(scene, 'a')).toBe(10);
    scene.apply([{ op: 'update', id: 'a', changes: { x: 20 } }]);
    scene.undo();
    expect(xOf(scene, 'a')).toBe(10);
    scene.redo();
    expect(xOf(scene, 'a')).toBe(20);
  });

  test('a whole drag is one undo step, whatever its frames', () => {
    const { scene } = seeded();
    const origin = scene.elements();
    for (const x of [5, 15, 40])
      scene.preview(origin.map((e) => (e.id === 'a' ? { ...e, x } : e)));
    scene.commitDrag(origin);
    expect(xOf(scene, 'a')).toBe(40);
    scene.undo();
    expect(xOf(scene, 'a')).toBe(0);
  });

  test('selecting keeps only live elements', () => {
    const { scene } = seeded();
    scene.apply([{ op: 'remove', ids: ['b'] }]);
    scene.select(['a', 'b', 'nowhere']);
    expect(scene.selectedIds()).toEqual(['a']);
  });

  test('undoing the step that made a selected element drops it from the selection', () => {
    const { scene } = seeded();
    scene.apply([{ op: 'remove', ids: ['a'] }]);
    scene.undo();
    scene.select(['a']);
    scene.redo();
    expect(scene.selectedIds()).toEqual([]);
  });
});
