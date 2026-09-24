// sheet/tools.ts#createTools against a real second adapter: a CanvasHandle
// whose scene is canvas/native/sheet-scene.ts, the model NativeCanvas draws.
// The wiring NativeCanvas -> Sheet.tsx#onCanvasChange -> tools.ownSelected
// is copied here as the scene's `changed` callback.
import { describe, expect, test } from 'bun:test';
import { createSheetScene } from '../src/sheet/canvas/native/sheet-scene.ts';
import type { CanvasHandle } from '../src/sheet/canvas/types.ts';
import type { ForeignShape } from '../src/sheet/overlay/screen.ts';
import { type Tools, createTools } from '../src/sheet/tools.ts';

function picture(id: string, x: number) {
  return {
    id,
    type: 'image',
    x,
    y: 0,
    width: 100,
    height: 100,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    groupIds: [`g-${id}`],
    customData: { kind: 'image', imageId: `img-${id}` },
  };
}

const foreignRegion = {
  id: 'foreign-1',
  kind: 'region',
  rect: { x: 10, y: 10, width: 20, height: 20 },
  label: 'theirs',
  sheetName: 'other',
  row: {},
} as unknown as ForeignShape;

function sheet() {
  let tools: Tools | null = null;
  const scene = createSheetScene(({ remote }) => {
    if (!remote) tools?.ownSelected(scene.selectedIds());
  });
  const handle: CanvasHandle = {
    elements: scene.elements,
    apply: scene.apply,
    applyRemote: scene.applyRemote,
    select: scene.select,
    selectedIds: scene.selectedIds,
    undo: scene.undo,
    redo: scene.redo,
    viewport: () => ({ scrollX: 0, scrollY: 0, zoom: 1 }),
    setViewport: () => {},
    wheel: () => {},
    zoomToFit: () => {},
    hitAt: () => null,
    zoomBy: () => {},
  };
  let foreign: string | null = null;
  tools = createTools({
    getHandle: () => handle,
    getForeignShapes: () => [foreignRegion],
    getSelectedForeignId: () => foreign,
    setSelectedForeign: (id) => {
      foreign = id;
    },
    getSyncStatus: () => 'synced' as never,
    getTool: () => 'select',
    setTool: () => {},
    getSheetId: () => 'sheet-1',
    onRenamed: () => {},
  });
  scene.applyRemote([picture('a', 0), picture('b', 200)]);
  return { tools, handle };
}

describe('the selection is one thing', () => {
  test('choosing a foreign claim empties the own selection', () => {
    const { tools, handle } = sheet();
    handle.select(['a']);
    tools.select('foreign-1');
    expect(handle.selectedIds()).toEqual([]);
    expect(tools.getSelected()?.kind).toBe('foreign');
  });

  test('an own element chosen past tools.select ends the foreign selection', () => {
    // The overlay's onSelectOwn, the arrow walk and a canvas click all
    // select on the canvas directly, never through tools.select.
    const { tools, handle } = sheet();
    tools.select('foreign-1');
    handle.select(['b']);
    const selected = tools.getSelected();
    expect(selected?.kind).toBe('own');
    expect(
      selected?.kind === 'own' ? selected.elements.map((e) => e.id) : [],
    ).toEqual(['b']);
  });

  test('deleting the selection removes own elements and can be undone', () => {
    const { tools, handle } = sheet();
    handle.select(['a']);
    tools.deleteSelected();
    expect(tools.getElements().map((e) => e.id)).toEqual(['b']);
    handle.undo();
    expect(tools.getElements().map((e) => e.id)).toEqual(['a', 'b']);
  });
});
