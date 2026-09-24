// Scene sync (CONTEXT.md "Snapshot"): what goes over the wire, and what
// comes back. One module since 2026-09-23; before, the concept was split
// four ways — the correction pass in Sheet.tsx, scene-diff.ts, the
// outbound dedupe and debounce inside room.ts's hook, and the inbound
// buffer and image gate inside that hook's effect — and they shared one
// signature through a ref that made sense only if you knew both sides.
// None of it had a test.
//
//   publish — a change made here: the correction pass (scene-diff.ts: a
//             region clamped to its image, the delete cascade), written
//             back without history, then sent, de-duplicated by signature
//             and debounced.
//   receive — a scene from the room: held (remote-scenes.ts) until every
//             picture it shows has loaded, folded with any scene that came
//             meanwhile, then applied. The signature is taken again after,
//             so a publish that only echoes it sends nothing.
//
// See ../../.claude/rules/foreign-never-in-scene.md: a foreign claim has no
// element in the scene, so there is no foreign clause here. If one seems
// needed, a foreign claim reached the scene, which is the bug to find.
import type { SceneElement, ScenePatch } from './canvas/types.ts';
import { RemoteSceneBuffer } from './remote-scenes.ts';
import { reconcileLocalChange } from './scene-diff.ts';

export interface SyncElement {
  id: string;
  version: number;
  updated: number;
  isDeleted: boolean;
}

export const DELETED_ELEMENT_TIMEOUT = 24 * 60 * 60 * 1000;
export const EMIT_DEBOUNCE_MS = 100;

/** Own elements, plus tombstones inside the 24h window, so a delete still
 * reaches a client that was offline. */
export function isSyncable(el: SyncElement): boolean {
  if (el.isDeleted) return el.updated > Date.now() - DELETED_ELEMENT_TIMEOUT;
  return true;
}

export function signature(elements: readonly SyncElement[]): string {
  return elements.map((e) => `${e.id}:${e.version}`).join(',');
}

/** The scene as sync sees it: the canvas handle, or a test's model. */
export interface SyncScene {
  elements(): SceneElement[];
  apply(patch: ScenePatch, opts: { history: false }): void;
  applyRemote(raw: unknown[]): void;
}

export interface SyncDeps {
  scene: () => SyncScene | null;
  /** Hands the syncable elements to the room. */
  send: (elements: SceneElement[]) => void;
  /** Loads pictures a received scene shows, before it is applied. */
  loadImages: (imageIds: string[]) => void | Promise<void>;
  /** A received scene is on the canvas. `scenes` counts the room's scene
   * deltas folded into it (a join's full scene is not one). */
  landed: (scenes: number) => void;
  /** Runs `fn` after `ms`; returns a cancel. */
  after?: (ms: number, fn: () => void) => () => void;
}

const windowAfter = (ms: number, fn: () => void) => {
  const handle = window.setTimeout(fn, ms);
  return () => window.clearTimeout(handle);
};

export function createSceneSync(deps: SyncDeps) {
  const after = deps.after ?? windowAfter;
  let lastSent = '';
  let cancelSend: (() => void) | null = null;
  let stopped = false;

  const buffer = new RemoteSceneBuffer();
  const loaded = new Set<string>();
  let scenesWaiting = 0;
  let draining: Promise<void> | null = null;

  function queueSend(elements: SceneElement[]) {
    const syncable = elements.filter(isSyncable);
    const sig = signature(syncable);
    if (sig === lastSent) return;
    lastSent = sig;
    cancelSend?.();
    cancelSend = after(EMIT_DEBOUNCE_MS, () => {
      cancelSend = null;
      if (!stopped) deps.send(syncable);
    });
  }

  /** A change made on this sheet. Returns the elements after the
   * correction pass, which is what the caller's own state should hold. */
  function publish(elements: SceneElement[]): SceneElement[] {
    const scene = deps.scene();
    const { ops, elements: next } = reconcileLocalChange(elements);
    if (ops.length) scene?.apply(ops, { history: false });
    queueSend(next);
    return next;
  }

  function picturesToLoad(elements: unknown[]): string[] {
    const ids = new Set<string>();
    for (const el of elements as {
      customData?: { kind?: string; imageId?: string };
    }[]) {
      const data = el.customData;
      if (data?.kind === 'image' && data.imageId && !loaded.has(data.imageId))
        ids.add(data.imageId);
    }
    return [...ids];
  }

  async function drain() {
    let elements = buffer.take();
    while (elements && !stopped) {
      const wanted = picturesToLoad(elements);
      if (wanted.length) {
        try {
          await deps.loadImages(wanted);
          for (const id of wanted) loaded.add(id);
        } catch (err) {
          console.error('remote sheet image load failed', err);
        }
      }
      if (stopped) return;
      // Fold any scene received during the load into this one, and check
      // its pictures again: the newer scene may show one not yet loaded.
      const later = buffer.take();
      if (later) {
        buffer.enqueue(elements);
        buffer.enqueue(later);
        elements = buffer.take();
        continue;
      }
      const scene = deps.scene();
      scene?.applyRemote(elements);
      lastSent = signature((scene?.elements() ?? []).filter(isSyncable));
      const scenes = scenesWaiting;
      scenesWaiting = 0;
      deps.landed(scenes);
      elements = buffer.take();
    }
  }

  /** A scene from the room. Resolves when every scene received so far is
   * on the canvas. */
  function receive(
    elements: unknown[],
    opts: { delta?: boolean } = {},
  ): Promise<void> {
    buffer.enqueue(elements);
    if (opts.delta) scenesWaiting++;
    if (!draining) {
      draining = drain()
        .catch((err) => console.error('remote sheet scene failed', err))
        .finally(() => {
          draining = null;
          if (buffer.hasPending() && !stopped) void receive([]);
        });
    }
    return draining;
  }

  /** The room closed: nothing more is sent or applied. */
  function stop() {
    stopped = true;
    buffer.take();
    cancelSend?.();
  }

  return { publish, receive, stop };
}

export type SceneSync = ReturnType<typeof createSceneSync>;
