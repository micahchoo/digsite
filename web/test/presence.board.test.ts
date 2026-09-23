import { describe, expect, test } from 'bun:test';
import type { PresenceViewer } from '@digsite/shared';
import {
  mergePresence,
  outlinesOf,
  pointedAt,
  rgbOf,
} from '../src/board/presence.ts';

const viewer = (
  key: string,
  over: Partial<PresenceViewer> = {},
): PresenceViewer => ({
  key,
  id: `u-${key}`,
  name: `Name ${key}`,
  colour: 'hsl(0, 100%, 50%)',
  hover: null,
  selected: [],
  ...over,
});

describe('who else is on the board', () => {
  test('a full list replaces, and this tab is never among the others', () => {
    const full = mergePresence(
      [viewer('old')],
      { full: true, viewers: [viewer('me'), viewer('a'), viewer('b')] },
      'me',
    );
    expect(full.map((v) => v.key)).toEqual(['a', 'b']);
  });

  test('one viewer’s change is merged by socket, not by person', () => {
    const now = mergePresence(
      [viewer('a'), viewer('a2', { id: 'u-a' })],
      { full: false, viewers: [viewer('a2', { id: 'u-a', hover: 'img-9' })] },
      'me',
    );
    expect(now.map((v) => [v.key, v.hover])).toEqual([
      ['a', null],
      ['a2', 'img-9'],
    ]);
  });

  test('what they point at, once each; outlines only where this sort has a rank', () => {
    const viewers = [
      viewer('a', { hover: 'img-1', selected: ['img-2', 'img-3'] }),
      viewer('b', { selected: ['img-2'] }),
    ];
    expect(pointedAt(viewers)).toEqual(['img-1', 'img-2', 'img-3']);
    const outlines = outlinesOf(
      viewers,
      new Map([
        ['img-1', 10],
        ['img-2', 20],
      ]),
    );
    expect(outlines.map((o) => [o.rank, o.name])).toEqual([
      [20, null],
      [10, 'Name a'],
      [20, null],
    ]);
  });

  test('a server colour is read as RGB for the map', () => {
    expect(rgbOf('hsl(0, 100%, 50%)')).toEqual([255, 0, 0]);
    expect(rgbOf('hsl(120 100% 25%)')).toEqual([0, 128, 0]);
    expect(rgbOf('#2566a8')).toEqual([37, 102, 168]);
    expect(rgbOf('teal')).toEqual([128, 128, 128]);
  });
});
