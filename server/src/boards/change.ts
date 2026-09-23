// Board change: the one way to say what a board's tiles draw has changed
// (.claude/rules/tile-pixels-change-the-build.md). Browsers keep a tile
// for good under its build token, so every change to pixels, status or
// order must end in a new build, and in this order:
//
//   1. publish each repainted ladder page, so other processes drop it,
//      as soon as it is written (pagesRepainted) — before any status
//      that makes a tile draw the page as final;
//   2. mark every order of the board stale;
//   3. invalidate this process and tell the others the ranks moved
//      (2 and 3 are boardChanged).
//
// NOTIFY delivers in commit order, and ranks.ts#rankOrder runs
// invalidation.ts#catchUp on the first sight of a build. So a process
// that meets the new build has already dropped the pages it replaced.
// Reverse 1 and 2 and it could draw the new build from old pages.
//
// Before this module the sequence was written out by five writers in
// three different ways. The seam lint in the rule forbids the raw calls
// anywhere else.
import type { LadderSize } from '@digsite/shared/board/ladder';
import { pool } from '../db/pool.ts';
import { invalidate, publish } from './invalidation.ts';

export type Repainted = { s: LadderSize; page: number }[];

/** Ladder pages this process has just written: every other process drops
 * its copy. Call it right after the write, and call boardChanged after
 * whatever else the change touches. */
export async function pagesRepainted(
  boardId: string,
  repainted: Repainted,
): Promise<void> {
  for (const { s, page } of repainted) {
    await publish({ kind: 'page', boardId, s, page });
  }
}

/** The board's tiles may draw something new: a picture was added,
 * painted, failed, edited or moved. Ends in a new build of every order. */
export async function boardChanged(boardId: string): Promise<void> {
  await pool.query(
    'UPDATE board_rank_state SET stale = true WHERE board_id = $1',
    [boardId],
  );
  await invalidate({ kind: 'ranks', boardId });
}
