// sheet/sync.ts#createSceneSync: what goes over the wire and what comes
// back, with a hand-driven clock and the sheet-scene model as the canvas.
import { describe, expect, test } from 'bun:test';
import { createSheetScene } from '../src/sheet/canvas/native/sheet-scene.ts';
import type { SceneElement } from '../src/sheet/canvas/types.ts';
import { EMIT_DEBOUNCE_MS, createSceneSync } from '../src/sheet/sync.ts';

function picture(id: string, version = 1, x = 0) {
  return {
    id,
    type: 'image',
    x,
    y: 0,
    width: 100,
    height: 100,
    version,
    versionNonce: 1,
    updated: Date.now(),
    isDeleted: false,
    groupIds: [`g-${id}`],
    customData: { kind: 'image', imageId: `img-${id}` },
  };
}

function harness() {
  const scene = createSheetScene();
  const sent: SceneElement[][] = [];
  const landed: number[] = [];
  const loads: string[][] = [];
  let release: (() => void) | null = null;
  let timers: { at: number; fn: () => void; live: boolean }[] = [];
  let now = 0;
  const sync = createSceneSync({
    scene: () => scene,
    send: (elements) => sent.push(elements),
    loadImages: (ids) => {
      loads.push(ids);
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    landed: (n) => landed.push(n),
    after: (ms, fn) => {
      const t = { at: now + ms, fn, live: true };
      timers.push(t);
      return () => {
        t.live = false;
      };
    },
  });
  const tick = (ms: number) => {
    now += ms;
    const due = timers.filter((t) => t.live && t.at <= now);
    timers = timers.filter((t) => !due.includes(t));
    for (const t of due) t.fn();
  };
  const loadDone = async () => {
    release?.();
    release = null;
    await Promise.resolve();
  };
  return { scene, sync, sent, landed, loads, tick, loadDone };
}

describe('publish', () => {
  test('a burst of changes is sent once, the last one, after the debounce', () => {
    const h = harness();
    h.scene.applyRemote([picture('a')]);
    const first = h.scene.elements();
    h.sync.publish(first);
    h.sync.publish(first.map((e) => ({ ...e, version: 2 })));
    h.tick(EMIT_DEBOUNCE_MS - 1);
    expect(h.sent).toHaveLength(0);
    h.tick(1);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.[0]?.version).toBe(2);
  });

  test('a change that moves no version sends nothing', () => {
    const h = harness();
    const els = [picture('a')] as unknown as SceneElement[];
    h.sync.publish(els);
    h.tick(EMIT_DEBOUNCE_MS);
    h.sync.publish(els.map((e) => ({ ...e, x: 99 })));
    h.tick(EMIT_DEBOUNCE_MS);
    expect(h.sent).toHaveLength(1);
  });

  test('a region pushed off its picture is pulled back, outside undo, and that is what is sent', () => {
    const h = harness();
    h.scene.applyRemote([
      picture('a'),
      {
        id: 'r',
        type: 'rectangle',
        x: 80,
        y: 10,
        width: 50,
        height: 20,
        version: 1,
        versionNonce: 1,
        updated: Date.now(),
        isDeleted: false,
        groupIds: ['g-a'],
        customData: {
          kind: 'region',
          imageId: 'img-a',
          label: '',
          properties: {},
        },
      },
    ]);
    const next = h.sync.publish(h.scene.elements());
    const region = (els: readonly SceneElement[]) =>
      els.find((e) => e.id === 'r');
    const right = (r?: SceneElement) => (r ? r.x + r.width : Number.NaN);
    expect(right(region(next))).toBeLessThanOrEqual(100);
    expect(right(region(h.scene.elements()))).toBeLessThanOrEqual(100);
    h.scene.undo();
    expect(right(region(h.scene.elements()))).toBeLessThanOrEqual(100);
    h.tick(EMIT_DEBOUNCE_MS);
    expect(right(region(h.sent.at(-1) ?? []))).toBeLessThanOrEqual(100);
  });

  test('a stopped sync sends nothing it was holding', () => {
    const h = harness();
    h.sync.publish([picture('a')] as unknown as SceneElement[]);
    h.sync.stop();
    h.tick(EMIT_DEBOUNCE_MS);
    expect(h.sent).toHaveLength(0);
  });
});

describe('receive', () => {
  test('a scene waits for its pictures; one that came meanwhile is folded in, its pictures loaded too', async () => {
    const h = harness();
    const done = h.sync.receive([picture('a')], { delta: true });
    expect(h.scene.elements()).toHaveLength(0);
    void h.sync.receive([picture('a', 2, 50), picture('b')], { delta: true });
    await h.loadDone();
    await h.loadDone();
    await done;
    expect(h.loads).toEqual([['img-a'], ['img-b']]);
    expect(h.scene.elements().map((e) => [e.id, e.x])).toEqual([
      ['a', 50],
      ['b', 0],
    ]);
    expect(h.landed).toEqual([2]);
  });

  test('what was received is not sent back', async () => {
    const h = harness();
    const done = h.sync.receive([picture('a')]);
    await h.loadDone();
    await done;
    h.sync.publish(h.scene.elements());
    h.tick(EMIT_DEBOUNCE_MS);
    expect(h.sent).toHaveLength(0);
    expect(h.landed).toEqual([0]);
  });
});
