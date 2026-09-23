// Every key the sheet answers, in one table. The toolbar takes its tool keys
// and tooltips from here, and the `?` panel lists it, so a key and the help
// that names it cannot drift apart. Ported from image-graph's
// `shortcuts.ts`: one action, one key, one line of help.
import type { Tool } from './gestures.ts';

export interface Shortcut {
  /** What a person presses, as it is shown: each entry is one key cap. */
  keys: string[];
  /** What it does, in the imperative. */
  does: string;
}

export interface ShortcutGroup {
  title: string;
  shortcuts: Shortcut[];
}

export const TOOLS: { tool: Tool; label: string; key: string }[] = [
  { tool: 'select', label: 'Select', key: 'v' },
  { tool: 'region', label: 'Region', key: 'r' },
  { tool: 'edge', label: 'Edge', key: 'e' },
  { tool: 'pan', label: 'Pan', key: 'h' },
];

const MOD = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? '')
  ? 'Cmd'
  : 'Ctrl';

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: 'Tools',
    shortcuts: [
      { keys: ['V'], does: 'Select and move' },
      { keys: ['R'], does: 'Mark a region on a picture' },
      { keys: ['E'], does: 'Connect: click the start, then the end' },
      { keys: ['H'], does: 'Pan' },
    ],
  },
  {
    title: 'Move around',
    shortcuts: [
      { keys: ['Arrow keys'], does: 'Go to the next picture that way' },
      {
        keys: ['Shift', 'arrow'],
        does: 'Add the next picture to the selection',
      },
      { keys: ['Space', 'drag'], does: 'Pan with any tool' },
      { keys: ['0'], does: 'Fit every picture in view' },
      { keys: ['+'], does: 'Zoom in' },
      { keys: ['-'], does: 'Zoom out' },
    ],
  },
  {
    title: 'Annotate',
    shortcuts: [
      { keys: ['Tab'], does: 'Next picture, in the Region tool' },
      { keys: ['Shift', 'Tab'], does: 'Previous picture' },
      { keys: ['Enter'], does: 'Keep the label or relation typed' },
      { keys: ['Esc'], does: 'Cancel what is in progress' },
    ],
  },
  {
    title: 'Edit',
    shortcuts: [
      { keys: ['Delete'], does: 'Remove what is selected' },
      { keys: [MOD, 'Z'], does: 'Undo' },
      { keys: [MOD, 'Shift', 'Z'], does: 'Redo' },
      { keys: ['?'], does: 'Show these keys' },
    ],
  },
];
