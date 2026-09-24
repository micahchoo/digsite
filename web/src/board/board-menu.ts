// The board's context menu: the picture under the pointer, or the map
// itself. Pure: it is handed what was clicked, the state the items read and
// what each item does, and returns the sections `ContextMenu` draws. The
// sheet's twin is sheet/sheet-menu.ts.
//
// Before 2026-09-23 the two builders lived inside Board.tsx, so which
// pictures an item acted on, and when Download was refused, had no test.
import type { MenuItem, MenuSection } from './ContextMenu.tsx';

/** The server's cap on one download (boards/routes.ts). */
export const DOWNLOAD_MAX = 500;

export interface BoardMenuState {
  selectedIds: readonly string[];
  /** The Find answer on the map, or null when nothing is being found. */
  find: { count: number; shown: number } | null;
  canUndo: boolean;
  canRedo: boolean;
}

export interface BoardMenuTarget {
  imageId: string;
  /** The section of the arrangement the picture is in, if any. */
  section: { label: string } | null;
}

export interface BoardMenuActions {
  fit: () => void;
  zoomToSelection: () => void;
  selectAllMatches: () => void;
  openFind: () => void;
  clearSelection: () => void;
  upload: () => void;
  importFolder: () => void;
  undo: () => void;
  redo: () => void;
  explore: (imageId: string) => void;
  selectSection: () => void;
  startSheet: (ids: readonly string[]) => void;
  addToSheet: (ids: readonly string[]) => void;
  openImage: (imageId: string) => void;
  properties: (imageId: string) => void;
  copyTo: (ids: readonly string[]) => void;
  download: (ids: readonly string[]) => void;
  /** Every claim on the board, from every sheet, as one report file. */
  report: () => void;
}

/**
 * The sections for a right-click on `target` (null: the map). A picture
 * that is part of the selection stands for all of it; any other picture
 * stands for itself alone.
 */
export function boardMenu(
  target: BoardMenuTarget | null,
  state: BoardMenuState,
  act: BoardMenuActions,
): MenuSection[] {
  return target ? pictureMenu(target, state, act) : mapMenu(state, act);
}

function mapMenu(state: BoardMenuState, act: BoardMenuActions): MenuSection[] {
  const selected = state.selectedIds.length > 0;
  const view: MenuItem[] = [{ label: 'Fit everything', onSelect: act.fit }];
  if (selected)
    view.push({
      label: 'Zoom to the selection',
      onSelect: act.zoomToSelection,
    });
  const find = state.find;
  const matches: MenuItem[] = [
    {
      label: find
        ? `Select all matches (${Math.min(find.count, find.shown)})`
        : 'Find and filter…',
      onSelect: find ? act.selectAllMatches : act.openFind,
      disabled: find !== null && find.shown === 0,
    },
  ];
  if (selected) {
    matches.push({ label: 'Clear selection', onSelect: act.clearSelection });
    matches.push(...copyItems(state.selectedIds, act));
  }
  const add: MenuItem[] = [
    { label: 'Upload images', onSelect: act.upload },
    {
      label: 'Import a folder from the server…',
      testId: 'board-menu-folder-import',
      onSelect: act.importFolder,
    },
  ];
  const report: MenuItem[] = [
    {
      label: 'Report on this board',
      testId: 'board-menu-report',
      onSelect: act.report,
    },
  ];
  const history: MenuItem[] = [
    { label: 'Undo selection', onSelect: act.undo, disabled: !state.canUndo },
    { label: 'Redo selection', onSelect: act.redo, disabled: !state.canRedo },
  ];
  return [view, matches, add, report, history];
}

function pictureMenu(
  { imageId, section }: BoardMenuTarget,
  state: BoardMenuState,
  act: BoardMenuActions,
): MenuSection[] {
  const acting = state.selectedIds.includes(imageId)
    ? state.selectedIds
    : [imageId];
  const explore: MenuItem[] = [
    { label: 'Explore connections', onSelect: () => act.explore(imageId) },
    { label: 'Select neighbourhood…', onSelect: () => act.explore(imageId) },
  ];
  if (section)
    explore.push({
      label: `Select this section ("${section.label}")`,
      onSelect: act.selectSection,
    });
  const sheet: MenuItem[] = [
    { label: 'Start a sheet', onSelect: () => act.startSheet(acting) },
    { label: 'Add to sheet…', onSelect: () => act.addToSheet(acting) },
  ];
  return [
    explore,
    sheet,
    [{ label: 'Open image', onSelect: () => act.openImage(imageId) }],
    [{ label: 'Properties', onSelect: () => act.properties(imageId) }],
    copyItems(acting, act),
  ];
}

function copyItems(ids: readonly string[], act: BoardMenuActions): MenuItem[] {
  const many = ids.length > 1 ? ` ${ids.length} pictures` : '';
  return [
    {
      label: `Copy${many} to another board…`,
      testId: 'board-menu-copy',
      onSelect: () => act.copyTo(ids),
    },
    {
      label: `Download${many}`,
      testId: 'board-menu-download',
      onSelect: () => act.download(ids),
      disabled: ids.length > DOWNLOAD_MAX,
      disabledReason: `At most ${DOWNLOAD_MAX} pictures in one download.`,
    },
  ];
}
