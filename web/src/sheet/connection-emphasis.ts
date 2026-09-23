// How strongly a connection is drawn. Two questions, both display only:
// does it carry the relation being emphasised, and does it touch what the
// person selected. With something selected, the connections that touch it
// stay at full strength and the rest go faint, so the lines that answer
// "what is this joined to" are the ones you can read. Ported from
// image-graph's `presentation.ts#connectionStyle`.
import { dataOf } from '@digsite/shared';

/** Alpha for a connection whose relation is not the emphasised one. */
const OFF_RELATION = 0.12;
/** Alpha for a connection that does not touch the selection. */
const OFF_FOCUS = 0.3;

/** Alpha used for relation emphasis in the canvas and foreign overlay. */
export function relationOpacity(
  relation: string,
  focus: string | null,
): number {
  return focus !== null && relation !== focus ? OFF_RELATION : 1;
}

/** What the person selected, as the connections see it: the selected
 * element ids, and the pictures the selected images and regions sit on. */
export interface Focus {
  ids: ReadonlySet<string>;
  images: ReadonlySet<string>;
}

interface Element {
  id: string;
  isDeleted?: boolean;
  customData?: unknown;
  startBinding?: { elementId: string } | null;
  endBinding?: { elementId: string } | null;
}

/** The focus for a selection, or null when nothing is selected — then
 * every connection is drawn at full strength. */
export function focusOf(
  elements: readonly Element[],
  selectedIds: Iterable<string>,
): Focus | null {
  const ids = new Set(selectedIds);
  if (!ids.size) return null;
  const images = new Set<string>();
  for (const el of elements) {
    if (!ids.has(el.id)) continue;
    const data = dataOf(el);
    if (data?.kind === 'image' || data?.kind === 'region')
      images.add(data.imageId);
  }
  return { ids, images };
}

/** The pictures an own connection's two ends sit on. */
export function endImages(
  edge: Element,
  byId: ReadonlyMap<string, Element>,
): (string | null)[] {
  return [edge.startBinding, edge.endBinding].map((binding) => {
    const end = binding ? byId.get(binding.elementId) : undefined;
    const data = end && !end.isDeleted ? dataOf(end) : null;
    return data?.kind === 'image' || data?.kind === 'region'
      ? data.imageId
      : null;
  });
}

/** Does this connection answer the current selection? Always true with
 * nothing selected. */
export function inFocus(
  focus: Focus | null,
  id: string,
  ends: readonly (string | null)[],
): boolean {
  if (!focus) return true;
  if (focus.ids.has(id)) return true;
  return ends.some((image) => image !== null && focus.images.has(image));
}

/** The alpha a connection is drawn at: the lower of the two answers. */
export function connectionOpacity(
  relation: string,
  emphasisedRelation: string | null,
  focused: boolean,
): number {
  return Math.min(
    relationOpacity(relation, emphasisedRelation),
    focused ? 1 : OFF_FOCUS,
  );
}
