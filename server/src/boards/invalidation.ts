// What a process holds in memory about a board, and how every process
// learns it changed. Three caches live per process: composed tiles
// (tiles-cache.ts), resident coarse sorts (coarse-cache.ts) and resident
// ladder pages (ladder.ts). Before this module each writer cleared only its
// own process's copy, so a worker running beside the API (`bun run worker`)
// left the API drawing old ladder pages and old coarse tiles indefinitely.
//
// `invalidate` clears this process and publishes on one Postgres channel;
// `listenForInvalidation` applies what other processes publish. A process
// ignores its own messages — it already applied them. NOTIFY is delivered
// only to live listeners: a process that starts later begins with empty
// caches, and one whose listener reconnects drops everything, because it
// cannot know what it missed.
import { randomUUID } from 'node:crypto';
import type { LadderSize } from '@digsite/shared/board/ladder';
import { Client } from 'pg';
import { pool } from '../db/pool.ts';
import { env } from '../env.ts';
import {
  invalidateAllResidentSorts,
  invalidateResidentSort,
} from './coarse-cache.ts';
import { forgetAllPages, forgetPage } from './ladder.ts';
import {
  invalidateAllComposedTiles,
  invalidateComposedTiles,
} from './tiles-cache.ts';

const CHANNEL = 'digsite_cache';
const ORIGIN = randomUUID();
const RECONNECT_MS = 1_000;

export type Invalidation =
  /** Ranks changed or went stale: every composed and coarse tile is wrong. */
  | { kind: 'ranks'; boardId: string }
  /** A ladder page was repainted: a resident copy of it is old pixels. */
  | { kind: 'page'; boardId: string; s: LadderSize; page: number }
  /** New coarse files are on disk: a resident copy of the old ones is wrong.
   * The writer installs the new ones itself, so it only publishes this. */
  | { kind: 'materialised'; boardId: string };

function apply(event: Invalidation): void {
  if (event.kind === 'page') {
    forgetPage(event.boardId, event.s, event.page);
    return;
  }
  invalidateResidentSort(event.boardId);
  if (event.kind === 'ranks') invalidateComposedTiles(event.boardId);
}

/** Tells every other process. A failed publish is logged, never thrown: the
 * write it describes has already happened, and the caller must not undo it. */
export async function publish(event: Invalidation): Promise<void> {
  try {
    await pool.query('SELECT pg_notify($1, $2)', [
      CHANNEL,
      JSON.stringify({ origin: ORIGIN, event }),
    ]);
  } catch (error) {
    console.error('[invalidation] publish failed', error);
  }
}

/** Clears this process now, then tells every other process. */
export async function invalidate(event: Invalidation): Promise<void> {
  apply(event);
  await publish(event);
}

/** Holds one dedicated connection (LISTEN needs its own; the pool's clients
 * are shared) and reconnects if it drops. Returns a stop function. */
export function listenForInvalidation(): () => void {
  let client: Client | null = null;
  let stopped = false;
  let connectedBefore = false;
  let retry: ReturnType<typeof setTimeout> | null = null;

  const reconnect = () => {
    client = null;
    if (!stopped) retry = setTimeout(connect, RECONNECT_MS);
  };

  const connect = async () => {
    const next = new Client({ connectionString: env.DATABASE_URL });
    next.on('notification', (message) => {
      if (message.channel !== CHANNEL || !message.payload) return;
      try {
        const { origin, event } = JSON.parse(message.payload);
        if (origin !== ORIGIN) apply(event as Invalidation);
      } catch (error) {
        console.error('[invalidation] bad message', error);
      }
    });
    next.on('error', (error) => {
      console.error('[invalidation] listener lost', error);
      next.end().catch(() => {});
      reconnect();
    });
    try {
      await next.connect();
      await next.query(`LISTEN ${CHANNEL}`);
      if (stopped) {
        await next.end();
        return;
      }
      client = next;
      if (connectedBefore) {
        forgetAllPages();
        invalidateAllComposedTiles();
        invalidateAllResidentSorts();
      }
      connectedBefore = true;
    } catch (error) {
      console.error('[invalidation] listen failed', error);
      next.end().catch(() => {});
      reconnect();
    }
  };

  connect();
  return () => {
    stopped = true;
    if (retry) clearTimeout(retry);
    client?.end().catch(() => {});
  };
}
