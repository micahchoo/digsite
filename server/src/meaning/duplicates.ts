import type { MeaningMatch } from '@digsite/shared/api';
// Near-duplicates of one image (roadmap item 4; CONTEXT.md "Near-duplicate"):
// a suggestion a person accepts or declines, never a decision.
//
// Two tests, because neither alone was enough on the owner's 141
// screenshots (docs/measurements/meaning-at-scale.md):
//  - CLIP similarity picks the candidates (>= 0.975), but it says what a
//    picture is OF: two screenshots of the same app with different text
//    scored 0.9857, above true re-captures at 0.9763.
//  - Pixels confirm: the share of the pictures' pixels that changed
//    noticeably between the two 128-px ladder cells. Above the gate, every
//    re-capture changed at most 0.32% and the one different state 0.72%.
//    Below it pixels alone do not separate (a different state at 0.31%),
//    so neither test is dropped.
// The share counts only pixels where either cell shows picture, not the
// #222 letterbox both share: a wide screenshot fills 40% of its cell, and
// counting the bars would halve every share. The ladder already holds the
// 128-px cell for every image, so this costs no storage.
import { LADDER, ladderAddress } from '@digsite/shared/board/ladder';
import type { Sort } from '@digsite/shared/board/sort';
import { withPage } from '../boards/ladder.ts';
import type { RankOrder } from '../boards/ranks.ts';
import { pool } from '../db/pool.ts';
import { similarTo } from './search.ts';

export const MIN_SIMILARITY = 0.975;
export const MAX_CHANGED = 0.005;
/** A grey level difference above this counts as a changed pixel. */
const PIXEL_DELTA = 24;
/** The ladder's letterbox (#222222) in grey. */
const BACKGROUND_GREY = 0x22;
/** Nearest neighbours checked by pixels; the rest cannot be closer. */
const CANDIDATES = 20;
const CELL = Math.max(...LADDER) as 128;

/** Grey levels of an image's 128-px ladder cell. */
async function cellGrey(boardId: string, slot: number): Promise<Uint8Array> {
  const { page, x, y } = ladderAddress(slot, CELL);
  return withPage(boardId, CELL, page, (canvas) => {
    const rgba = canvas.getContext('2d').getImageData(x, y, CELL, CELL).data;
    const grey = new Uint8Array(CELL * CELL);
    for (let i = 0; i < grey.length; i++) {
      grey[i] = Math.round(
        0.299 * (rgba[i * 4] as number) +
          0.587 * (rgba[i * 4 + 1] as number) +
          0.114 * (rgba[i * 4 + 2] as number),
      );
    }
    return grey;
  });
}

/** Share of picture pixels whose grey level differs by more than
 * PIXEL_DELTA. A pixel that is letterbox in both cells is not counted. */
export function changedFraction(a: Uint8Array, b: Uint8Array): number {
  let changed = 0;
  let picture = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    if (x === BACKGROUND_GREY && y === BACKGROUND_GREY) continue;
    picture++;
    if (Math.abs(x - y) > PIXEL_DELTA) changed++;
  }
  return picture === 0 ? 0 : changed / picture;
}

/** Near-duplicates of `imageId` on its board, most similar first. Null when
 * the image is not embedded yet. `score` is the CLIP similarity. */
export async function duplicatesOf(
  boardId: string,
  imageId: string,
  sort: Sort,
  given?: RankOrder,
): Promise<MeaningMatch[] | null> {
  const near = await similarTo(boardId, imageId, sort, CANDIDATES, given);
  if (near === null) return null;
  const candidates = near.filter((m) => m.score >= MIN_SIMILARITY);
  if (candidates.length === 0) return [];
  const { rows } = await pool.query(
    `SELECT id, slot FROM images
     WHERE board_id = $1 AND id = ANY($2::uuid[]) AND status = 'ready' AND NOT missing`,
    [boardId, [imageId, ...candidates.map((m) => m.imageId)]],
  );
  const slotOf = new Map(rows.map((r) => [r.id as string, r.slot as number]));
  const anchorSlot = slotOf.get(imageId);
  if (anchorSlot === undefined) return [];
  const anchor = await cellGrey(boardId, anchorSlot);
  const found: MeaningMatch[] = [];
  for (const match of candidates) {
    const slot = slotOf.get(match.imageId);
    if (slot === undefined) continue;
    if (changedFraction(anchor, await cellGrey(boardId, slot)) <= MAX_CHANGED)
      found.push(match);
  }
  return found;
}
