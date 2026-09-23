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
const CATCH_UP_MS = 2_000;

export type Invalidation =
  /** Ranks changed or went stale: every composed and coarse tile is wrong. */
  | { kind: 'ranks'; boardId: string }
  /** A ladder page was repainted: a resident copy of it is old pixels. */
  | { kind: 'page'; boardId: string; s: LadderSize; page: number }
  /** New coarse files are on disk: a resident copy of the old ones is wrong.
   * The writer installs the new ones itself, so it only publishes this. */
  | { kind: 'materialised'; boardId: string };

/** A process's own marker (catchUp), never applied by anyone. */
type Sync = { kind: 'sync'; id: string };

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

// catchUp's waiters, by marker id; and whether a listener is connected.
const waiting = new Map<string, () => void>();
let listening = false;

function forgetEverything(): void {
  forgetAllPages();
  invalidateAllComposedTiles();
  invalidateAllResidentSorts();
}

/** Returns once this process has applied every invalidation that was
 * published before the call. Roadmap item 7: a tile is cached by the
 * browser forever under its order's version, so a process that learns a
 * new version from the database must not draw it from pixels it has not
 * yet been told are old. The worker publishes a repainted page BEFORE it
 * marks ranks stale, so the page event is committed before any build it
 * causes; NOTIFY delivers in commit order, so once our own marker comes
 * back, the page event has been applied. Without a listener there is
 * nothing to lag behind. If the marker does not come back in time, this
 * process drops every cache, as it does on a reconnect. */
export async function catchUp(): Promise<void> {
  if (!listening) return;
  const id = randomUUID();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const back = new Promise<boolean>((resolve) => {
    waiting.set(id, () => resolve(true));
    timer = setTimeout(() => resolve(false), CATCH_UP_MS);
  });
  await pool.query('SELECT pg_notify($1, $2)', [
    CHANNEL,
    JSON.stringify({ origin: ORIGIN, event: { kind: 'sync', id } }),
  ]);
  const returned = await back;
  clearTimeout(timer);
  waiting.delete(id);
  if (!returned) {
    console.error('[invalidation] catch-up timed out; dropping every cache');
    forgetEverything();
  }
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
        const { origin, event } = JSON.parse(message.payload) as {
          origin: string;
          event: Invalidation | Sync;
        };
        if (event.kind === 'sync') {
          if (origin === ORIGIN) waiting.get(event.id)?.();
          return;
        }
        if (origin !== ORIGIN) apply(event);
      } catch (error) {
        console.error('[invalidation] bad message', error);
      }
    });
    next.on('error', (error) => {
      console.error('[invalidation] listener lost', error);
      listening = false;
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
      if (connectedBefore) forgetEverything();
      connectedBefore = true;
      listening = true;
    } catch (error) {
      console.error('[invalidation] listen failed', error);
      next.end().catch(() => {});
      reconnect();
    }
  };

  connect();
  return () => {
    stopped = true;
    listening = false;
    if (retry) clearTimeout(retry);
    client?.end().catch(() => {});
  };
}
