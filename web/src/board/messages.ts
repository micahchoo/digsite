// Pure formatting for the two delete confirmations (docs/phases/3-groups.md
// section 4): the counts come from the server's footprint routes, but the
// sentence around them is web's to get right and to test — unlike a 403
// reason (../.claude/rules/access-one-function-per-intent.md: the web
// never decides access, so there's nothing here to unit test for that),
// this is pure string shaping with no access decision in it.
import type { BoardFootprint, SheetFootprint } from '@digsite/shared/api';
import { plural } from '../lib/plural.ts';

export function boardDeleteMessage(
  name: string,
  footprint: BoardFootprint,
): string {
  return (
    `Delete "${name}"? This removes ${plural(footprint.images, 'image')}, ` +
    `${plural(footprint.sheets, 'sheet')}, ${plural(footprint.regions, 'region')} ` +
    `and ${plural(footprint.edges, 'edge')}.`
  );
}

export function sheetDeleteMessage(
  name: string,
  footprint: SheetFootprint,
): string {
  if (footprint.foreignViews === 0) {
    return `Delete "${name}"? No other sheet shows a claim from it as foreign.`;
  }
  return (
    `Delete "${name}"? This removes its claims currently showing as ` +
    `foreign in ${plural(footprint.foreignViews, 'other sheet')}.`
  );
}
