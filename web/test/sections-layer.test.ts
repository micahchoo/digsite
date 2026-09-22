// Pure: a section boundary's fromRank -> where its label/line sit in world
// space. No deck.gl, no DOM — see ../src/board/sections-layer.ts.
import { describe, expect, test } from 'bun:test';
import { COLS } from '@digsite/shared';
import {
  sectionMarkers,
  sectionsVisible,
} from '../src/board/sections-layer.ts';

describe('sectionMarkers', () => {
  test("places the label and the line's start at the section's first cell", () => {
    const markers = sectionMarkers([{ label: '1900', fromRank: 0, toRank: 9 }]);
    expect(markers).toEqual([
      {
        label: '1900',
        fromRank: 0,
        textPosition: [0, 0],
        lineStart: [0, 0],
        lineEnd: [0, 128],
      },
    ]);
  });

  test('the line spans one row (CELL world units) down from the cell', () => {
    const markers = sectionMarkers([{ label: 'x', fromRank: 5, toRank: 5 }]);
    expect(markers).toHaveLength(1);
    const m = markers[0];
    if (!m) throw new Error('expected a marker');
    expect(m.lineEnd[1] - m.lineStart[1]).toBe(128);
  });

  test('wraps to the next row at COLS ranks, matching cellOf', () => {
    const [m] = sectionMarkers([
      { label: 'row1', fromRank: COLS, toRank: COLS + 5 },
    ]);
    expect(m?.textPosition).toEqual([0, 128]);
  });

  test('a mid-row rank lands at its own column', () => {
    const [m] = sectionMarkers([{ label: 'mid', fromRank: 3, toRank: 3 }]);
    expect(m?.textPosition).toEqual([3 * 128, 0]);
  });

  test('one marker per section, in order', () => {
    const markers = sectionMarkers([
      { label: 'a', fromRank: 0, toRank: 4 },
      { label: 'b', fromRank: 5, toRank: 9 },
    ]);
    expect(markers.map((m) => m.label)).toEqual(['a', 'b']);
  });
});

describe('sectionsVisible', () => {
  test('hidden below z = -4, visible at and above it', () => {
    expect(sectionsVisible(0)).toBe(true);
    expect(sectionsVisible(-4)).toBe(true);
    expect(sectionsVisible(-4.5)).toBe(false);
    expect(sectionsVisible(-5)).toBe(false);
  });
});
