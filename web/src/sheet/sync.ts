// What goes over the wire to the server's snapshot debounce, and nothing
// else. See ../../.claude/rules/foreign-never-in-scene.md: a foreign claim
// has no element in the scene, so there is no foreign clause here — if one
// seems needed, a foreign claim reached the scene, which is the bug to find.
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';

export const DELETED_ELEMENT_TIMEOUT = 24 * 60 * 60 * 1000;

/** Own elements, plus tombstones inside the 24h window (excalidraw-app's own
 * isSyncableElement), so a delete still reaches a client that was offline. */
export function isSyncable(el: ExcalidrawElement): boolean {
  if (el.isDeleted) return el.updated > Date.now() - DELETED_ELEMENT_TIMEOUT;
  return true;
}

export function signature(elements: readonly ExcalidrawElement[]): string {
  return elements.map((e) => `${e.id}:${e.version}`).join(',');
}
