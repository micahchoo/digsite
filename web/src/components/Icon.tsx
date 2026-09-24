// Every icon the product draws, on one 20-unit grid with one stroke. A
// typed character is never an icon: `×`, `↗`, `#` or `+` renders in
// whatever font the browser picks, at that font's weight and baseline, so
// no two of them match each other or the drawn icons beside them.
//
// Icons are decorative: the control that holds one names itself with
// `aria-label` or visible text.
import { DIRECTION_PATHS } from '@digsite/shared/icons';
import type { SVGProps } from 'react';

const PATHS = {
  close: 'm5.5 5.5 9 9m0-9-9 9',
  plus: 'M10 4.5v11M4.5 10h11',
  minus: 'M4.5 10h11',
  fit: 'M4 7.5V4h3.5m5 0H16v3.5m0 5V16h-3.5m-5 0H4v-3.5',
  chevronDown: 'm6 8 4 4 4-4',
  chevronRight: 'm8 6 4 4-4 4',
  menu: 'M3 5.5h14M3 10h14M3 14.5h14',
  panel:
    'M5 3.5h10a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Zm6.5.5v12',
  arrowLeft: DIRECTION_PATHS.reverse,
  arrowRight: DIRECTION_PATHS.forward,
  arrowDown: 'M10 4v12m0 0-4-4m4 4 4-4',
  arrowUp: 'M10 16V4m0 0L6 8m4-4 4 4',
  arrowBoth: DIRECTION_PATHS.both,
  // A connection's handle: drag from it to another image or region.
  connect: 'M4 10h8m0 0-3-3m3 3-3 3M15.5 10a1.5 1.5 0 1 0 0 .01',
  arrowUpRight: 'M6.5 13.5 13.5 6.5m0 0H8m5.5 0V12',
  upload:
    'M10 13V3m0 0L6.5 6.5M10 3l3.5 3.5M4 12.5v3A1.5 1.5 0 0 0 5.5 17h9a1.5 1.5 0 0 0 1.5-1.5v-3',
  search: 'M14.2 8.6a5.6 5.6 0 1 1-11.2 0 5.6 5.6 0 0 1 11.2 0ZM13 13l4 4',
  // Zero-length segments with round caps draw as dots.
  more: 'M4.5 10h.01M10 10h.01M15.5 10h.01',
  trash:
    'M4.5 5.5h11M8 5.5V4h4v1.5m2.5 0-.7 10.2a1.5 1.5 0 0 1-1.5 1.3H7.7a1.5 1.5 0 0 1-1.5-1.3L5.5 5.5m3 3v5m3-5v5',
  hash: 'M8 3.5 6.5 16.5m7-13L12 16.5M4 7.5h12.5M3.5 12.5H16',
  // A sheet hangs off its board: the thread hook.
  group: 'M16 10a6 6 0 1 1-12 0 6 6 0 0 1 12 0Z',
  pencil: 'M12.5 4.5l3 3L8 15H5v-3l7.5-7.5Z',
  // Two lines joining into one: two terms that mean the same.
  merge: 'M4 5c4 0 5 5 8 5h4M4 15c4 0 5-5 8-5m1.5-3 2.5 3-2.5 3',
  lock: 'M6.5 9V7a3.5 3.5 0 0 1 7 0v2M5.5 9h9a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1Z',
  settings: 'M3.5 6.5h7m3 0h3M3.5 13.5h3m3 0h7M12 4.5v4M8 11.5v4',
  alert: 'M10 5.5v5.5m0 3.5h.01',
  // The sheet's tools and view controls (sheet/Toolbar.tsx).
  cursor: 'm5 3 9 8-4 .5 2 4-2 1-2-4-3 2z',
  region:
    'M4.5 6V4h2M9 4h2M13.5 4h2v2M15.5 9v2M15.5 14v2h-2M11 16H9M6.5 16h-2v-2M4.5 11V9',
  edge: 'M3 15 14 4m0 0h-5m5 0v5m-2 4 4 3',
  hand: 'M7 10V5.5a1.5 1.5 0 0 1 3 0V9m0-2a1.5 1.5 0 0 1 3 0v3m0-1a1.5 1.5 0 0 1 3 0v4a5 5 0 0 1-5 5h-1.5a4 4 0 0 1-3.2-1.6L4 13.5a1.4 1.4 0 0 1 2.1-1.8L7 13',
  zoomIn:
    'M14 8.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0ZM6 8.5h5M8.5 6v5m4 1.5 4 4',
  zoomOut: 'M14 8.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0ZM6 8.5h5m1.5 4 4 4',
  undo: 'M7 7 3.5 10.5 7 14M4 10.5h6a5 5 0 0 1 5 5',
  redo: 'm13 7 3.5 3.5L13 14m3-3.5h-6a5 5 0 0 0-5 5',
  // Where a person starts: the workspaces, before any group.
  home: 'm2.5 9.2 7.5-5.8 7.5 5.8M4.6 7.9v8.3h10.8V7.9M7.9 16.2v-5h4.2v5',
  // A sheet: a page with its corner folded.
  // A sheet: a canvas holding pictures. Not a page of lines, which is a
  // report; not a hooked arrow, which read as a new-line mark.
  sheet: 'M3.5 4.5h13v11h-13ZM6 7h4v3.5H6ZM11.5 9h2.5v4h-2.5Z',
  // A board open to the whole group; `lock` is a private one.
  open: 'M16.56 10a6.56 6.56 0 1 1-13.12 0 6.56 6.56 0 0 1 13.12 0ZM7.12 10h5.76',
  // Groups, and one more: the rail's way back to every workspace.
  groups:
    'M4.59 2.92h2.49a1.67 1.67 0 0 1 1.67 1.67v2.49a1.67 1.67 0 0 1-1.67 1.67H4.59a1.67 1.67 0 0 1-1.67-1.67V4.59a1.67 1.67 0 0 1 1.67-1.67ZM12.92 2.92h2.49a1.67 1.67 0 0 1 1.67 1.67v2.49a1.67 1.67 0 0 1-1.67 1.67h-2.49a1.67 1.67 0 0 1-1.67-1.67V4.59a1.67 1.67 0 0 1 1.67-1.67ZM4.59 11.25h2.49a1.67 1.67 0 0 1 1.67 1.67v2.49a1.67 1.67 0 0 1-1.67 1.67H4.59a1.67 1.67 0 0 1-1.67-1.67v-2.49a1.67 1.67 0 0 1 1.67-1.67ZM11.25 14.17h5.83M14.17 11.25v5.83',
  keyboard:
    'M3.5 5.5h13a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1ZM6 8.5h.01M9 8.5h.01M12 8.5h.01M15 8.5h.01M7 11.5h6',
  report: 'M5.5 2.5h6l3.5 3.5v11.5h-9.5ZM11.5 2.5V6H15M8 10h4.5M8 13h4.5',
  // Keep a report: a bookmark, the thing you come back to.
  keep: 'M6 3.5h8v13l-4-3-4 3Z',
  person:
    'M10 9.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm-5.5 7c.6-2.6 2.9-4.5 5.5-4.5s4.9 1.9 5.5 4.5',
  signOut:
    'M8.5 4H5.5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3M12 6.5 15.5 10 12 13.5M15.5 10H8',
} as const;

export type IconName = keyof typeof PATHS;

interface Props extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  size?: number;
}

export function Icon({ name, size = 18, className, ...rest }: Props) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={name === 'more' ? 2.6 : 1.65}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ? `icon ${className}` : 'icon'}
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
