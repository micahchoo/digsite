// Pure: a section boundary -> where its label and marker line sit in world
// space. `cellOf` is the one grid arithmetic (../.claude/rules/ladder-slot-vs-rank.md
// binds this to shared/src/board/grid.ts, never reimplemented here). Kept
// separate from Board.tsx so it is testable with no deck.gl and no DOM.
import { CELL, type Section, cellOf } from '@digsite/shared';

export interface SectionMarker {
  label: string;
  fromRank: number;
  /** World-space anchor for the TextLayer label, at the section's first cell. */
  textPosition: [number, number];
  /** The LineLayer segment along that cell's left edge, spanning the row. */
  lineStart: [number, number];
  lineEnd: [number, number];
}

export function sectionMarkers(sections: Section[]): SectionMarker[] {
  return sections.map((s) => {
    const { col, row } = cellOf(s.fromRank);
    const x = col * CELL;
    const y = row * CELL;
    return {
      label: s.label,
      fromRank: s.fromRank,
      textPosition: [x, y],
      lineStart: [x, y],
      lineEnd: [x, y + CELL],
    };
  });
}

/** Sections stop mattering once cells are smaller than a label can sit in —
 * design.md ties this to the same z >= -4 as the LineLayer. */
export function sectionsVisible(zoom: number): boolean {
  return zoom >= -4;
}
