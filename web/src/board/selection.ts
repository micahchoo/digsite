// What a press on the map does to the selection, and the shapes the
// selection is drawn with. Pure: no DOM, no deck.gl.
import { CELL, cellOf } from '@digsite/shared';

/** A press on one cell, with the modifiers that change its meaning. */
export type Press = { rank: number; toggle: boolean; extend: boolean };

/** What the press does. `anchor` is the rank a later Shift+press extends
 * from. A range is resolved by the server (design.md §5.1), so it carries
 * ranks, never ids. */
export type PressMove = { anchor: number | null } & (
  | { kind: 'range'; from: number; to: number }
  | { kind: 'toggle' | 'only'; id: string }
  | { kind: 'clear' }
  | { kind: 'none' }
);

/**
 * Shift extends a range from the last press, and never looks the cell's
 * image up. Ctrl/Cmd toggles one image. A plain press selects only that
 * image, and a plain press on the only selected image clears it. A cell
 * whose image cannot be read does nothing and moves no anchor.
 */
export async function pressMove(
  press: Press,
  anchor: number | null,
  selected: readonly string[],
  imageAt: (rank: number) => Promise<string | null>,
): Promise<PressMove> {
  if (press.extend && anchor !== null) {
    return { kind: 'range', from: anchor, to: press.rank, anchor: press.rank };
  }
  const id = await imageAt(press.rank);
  if (!id) return { kind: 'none', anchor };
  const moved = { anchor: press.rank };
  if (press.toggle) return { kind: 'toggle', id, ...moved };
  if (selected.length === 1 && selected[0] === id) {
    return { kind: 'clear', ...moved };
  }
  return { kind: 'only', id, ...moved };
}

/** The world-space square a rank's cell occupies, for the selection outline
 * PolygonLayer — a closed ring, top-left origin, CELL units on a side. */
export function cellPolygon(rank: number): [number, number][] {
  const { col, row } = cellOf(rank);
  const x = col * CELL;
  const y = row * CELL;
  return [
    [x, y],
    [x + CELL, y],
    [x + CELL, y + CELL],
    [x, y + CELL],
  ];
}

/** A small triangle in a cell's top-right corner, world space: the mark on
 * an image some sheet has annotated (CONTEXT.md "Making sense"). */
export function cellCorner(rank: number, size: number): [number, number][] {
  const { col, row } = cellOf(rank);
  const right = (col + 1) * CELL;
  const top = row * CELL;
  return [
    [right - size, top],
    [right, top],
    [right, top + size],
  ];
}
