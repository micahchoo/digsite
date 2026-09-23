// What a screen reader hears when the selection changes on a sheet: what
// was chosen, and what it is connected to. One sentence, said once, never
// mid-gesture (the selection changes on release). image-graph's
// announcer, for claims.
import { dataOf } from '@digsite/shared';

interface Element {
  id: string;
  isDeleted?: boolean;
  customData?: unknown;
  startBinding?: { elementId: string } | null;
  endBinding?: { elementId: string } | null;
}

export function describeSelection(
  selectedIds: readonly string[],
  elements: readonly Element[],
  nameOf: (imageId: string) => string,
): string {
  if (!selectedIds.length) return 'Nothing selected.';
  if (selectedIds.length > 1) return `${selectedIds.length} selected.`;
  const live = elements.filter((el) => !el.isDeleted);
  const byId = new Map(live.map((el) => [el.id, el] as const));
  const el = byId.get(selectedIds[0] as string);
  const data = el ? dataOf(el) : null;
  if (!el || !data) return 'Nothing selected.';

  const imageOf = (id: string | undefined) => {
    const end = id ? byId.get(id) : undefined;
    const d = end ? dataOf(end) : null;
    return d?.kind === 'image' || d?.kind === 'region' ? d.imageId : null;
  };
  const edgesTouching = (imageId: string) =>
    live.filter((e) => {
      const d = dataOf(e);
      return (
        d?.kind === 'edge' &&
        (imageOf(e.startBinding?.elementId) === imageId ||
          imageOf(e.endBinding?.elementId) === imageId)
      );
    });
  const relations = (list: Element[]) => {
    const names = list.map((e) => {
      const d = dataOf(e);
      return d?.kind === 'edge' ? d.relation || 'unnamed' : '';
    });
    return names.length
      ? ` ${names.length} connection${names.length === 1 ? '' : 's'}: ${names.join(', ')}.`
      : ' No connections.';
  };

  if (data.kind === 'image')
    return `${nameOf(data.imageId)} selected.${relations(edgesTouching(data.imageId))}`;
  if (data.kind === 'region')
    return `Region ${data.label || 'unlabelled'} on ${nameOf(data.imageId)} selected.`;
  const from = imageOf(el.startBinding?.elementId);
  const to = imageOf(el.endBinding?.elementId);
  const ends = from && to ? `, from ${nameOf(from)} to ${nameOf(to)}` : '';
  const sure = data.confidence ? `, ${data.confidence}` : '';
  return `Connection ${data.relation || 'unnamed'}${ends}${sure} selected.`;
}
