// The sheet's context menu, in image-graph's fixed sections: the thing under
// the pointer, how sure a connection is, the view, undo and redo, and
// removal last in a group of its own. Pure: it is handed what was clicked
// and what each item does, and returns the sections `ContextMenu` draws.
//
// One action, three surfaces: every item here is also a key (shortcuts.ts)
// or a control in the details panel, and calls the same function.
import { type Confidence, dataOf } from '@digsite/shared';
import type { MenuSection } from '../board/ContextMenu.tsx';

export interface MenuTarget {
  id: string;
  kind: 'image' | 'region' | 'edge';
}

interface Element {
  id: string;
  isDeleted?: boolean;
  customData?: unknown;
}

export interface SheetMenuActions {
  /** Frame these elements, or every picture when none are given. */
  fit: (ids?: string[]) => void;
  /** Switch to the Region tool framed on this picture. */
  markRegion: (imageElementId: string) => void;
  /** Make a picture of its own from this region, beside its parent. */
  extract: (regionId: string) => void;
  /** Open the relation picker on this connection. */
  rename: (edgeId: string) => void;
  setConfidence: (edgeId: string, confidence: Confidence | null) => void;
  reverse: (edgeId: string) => void;
  remove: (ids: string[]) => void;
  undo: () => void;
  redo: () => void;
  help: () => void;
}

const HOW_SURE: [Confidence | null, string][] = [
  ['confirmed', 'Confirmed'],
  ['likely', 'Likely'],
  ['unverified', 'Unverified'],
  [null, 'Not stated'],
];

const MOD = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? '')
  ? 'Cmd'
  : 'Ctrl';

/**
 * The sections for a right-click on `target` (null: empty canvas) while
 * `selectedIds` is the selection it acts on. A right-click on something
 * already selected keeps the selection, so the items act on all of it.
 */
export function sheetMenu(
  target: MenuTarget | null,
  selectedIds: readonly string[],
  elements: readonly Element[],
  act: SheetMenuActions,
): MenuSection[] {
  const byId = new Map(elements.map((el) => [el.id, el] as const));
  const several = selectedIds.length > 1;
  const thing: MenuSection = [];
  const sure: MenuSection = [];

  if (target && several) {
    thing.push({
      label: `Fit these ${selectedIds.length}`,
      testId: 'sheet-menu-fit-selection',
      onSelect: () => act.fit([...selectedIds]),
    });
  } else if (target?.kind === 'image') {
    thing.push(
      {
        label: 'Mark a region on it',
        keys: 'R',
        testId: 'sheet-menu-mark-region',
        onSelect: () => act.markRegion(target.id),
      },
      {
        label: 'Fit to this picture',
        testId: 'sheet-menu-fit-one',
        onSelect: () => act.fit([target.id]),
      },
    );
  } else if (target?.kind === 'region') {
    thing.push(
      {
        label: 'Make a picture of this region',
        testId: 'sheet-menu-extract',
        onSelect: () => act.extract(target.id),
      },
      {
        label: 'Fit to this region',
        testId: 'sheet-menu-fit-one',
        onSelect: () => act.fit([target.id]),
      },
    );
  } else if (target?.kind === 'edge') {
    const el = byId.get(target.id);
    const data = el ? dataOf(el) : null;
    if (data?.kind === 'edge') {
      thing.push({
        label: data.relation ? 'Rename relation…' : 'Name relation…',
        testId: 'sheet-menu-rename',
        onSelect: () => act.rename(target.id),
      });
      if (data.direction === 'forward' || data.direction === 'reverse')
        thing.push({
          label: 'Reverse direction',
          testId: 'sheet-menu-reverse',
          onSelect: () => act.reverse(target.id),
        });
      for (const [value, label] of HOW_SURE)
        sure.push({
          label,
          checked: (data.confidence ?? null) === value,
          testId: `sheet-menu-sure-${value ?? 'unstated'}`,
          onSelect: () => act.setConfidence(target.id, value),
        });
    }
  }

  const view: MenuSection = [
    {
      label: 'Fit every picture',
      keys: '0',
      testId: 'sheet-menu-fit-all',
      onSelect: () => act.fit(),
    },
    {
      label: 'Keyboard shortcuts',
      keys: '?',
      testId: 'sheet-menu-help',
      onSelect: act.help,
    },
  ];
  const history: MenuSection = [
    { label: 'Undo', keys: `${MOD}+Z`, onSelect: act.undo },
    { label: 'Redo', keys: `${MOD}+Shift+Z`, onSelect: act.redo },
  ];

  const removal: MenuSection = [];
  if (target) {
    const ids = several ? [...selectedIds] : [target.id];
    removal.push({
      label: several
        ? `Delete ${ids.length} items`
        : target.kind === 'image'
          ? 'Remove picture from this sheet'
          : target.kind === 'region'
            ? 'Delete region'
            : 'Delete connection',
      keys: 'Delete',
      danger: true,
      testId: 'sheet-menu-delete',
      onSelect: () => act.remove(ids),
    });
  }
  return [thing, sure, view, history, removal];
}
