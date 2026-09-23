// Phase 5 section 2 (docs/phases/5-hardening.md "Abuse limits"): a token
// bucket per (user, action), in memory — one process, no shared state, no
// extra infra for a limit whose only job is smoothing one bad client. A
// refusal is `429 {reason, retryAfter}` with a `Retry-After` header over
// HTTP (`tooManyRequests` below); on the socket, `limited {reason}` then
// drop (sheets/room.ts calls checkLimit directly for that).
import type { ServerResponse } from 'node:http';
import { env } from './env.ts';
import { json } from './http.ts';

export type LimitAction =
  | 'upload'
  | 'tus-create'
  | 'socket-connect'
  | 'scene-emit';

type LimitConfig = { capacity: number; windowMs: number };

// One row per action named in docs/phases/5-hardening.md section 2 — the
// limit value there IS the bucket capacity, refilled continuously over the
// stated window (6000 files/min == capacity 6000, windowMs 60_000; 30
// emits/s == capacity 30, windowMs 1_000).
const LIMITS: Record<LimitAction, LimitConfig> = {
  upload: { capacity: env.RATE_UPLOAD_PER_MIN, windowMs: 60_000 },
  'tus-create': { capacity: env.RATE_TUS_CREATE_PER_MIN, windowMs: 60_000 },
  'socket-connect': {
    capacity: env.RATE_SOCKET_CONNECT_PER_MIN,
    windowMs: 60_000,
  },
  'scene-emit': { capacity: env.RATE_SCENE_EMIT_PER_SEC, windowMs: 1_000 },
};

type Bucket = { tokens: number; updatedAt: number };
const buckets = new Map<string, Bucket>(); // key: `${action}:${userId}`

function bucketKey(action: LimitAction, userId: string): string {
  return `${action}:${userId}`;
}

// Unbounded growth guard: a bucket that hasn't been touched in 10 minutes
// is long since full again and costs nothing to recompute from scratch, so
// it's dropped rather than kept forever — every distinct user who ever
// uploaded a file otherwise stays resident for the life of the process.
// Swept lazily (every 500th call) rather than on a timer, so this module
// starts no interval a test would have to stop.
let sinceSweep = 0;
const SWEEP_EVERY = 500;
const IDLE_CUTOFF_MS = 10 * 60_000;

function maybeSweep(now: number): void {
  if (++sinceSweep < SWEEP_EVERY) return;
  sinceSweep = 0;
  const cutoff = now - IDLE_CUTOFF_MS;
  for (const [key, b] of buckets) {
    if (b.updatedAt < cutoff) buckets.delete(key);
  }
}

export type LimitResult =
  | { allowed: true }
  | { allowed: false; retryAfter: number };

/** Consumes `count` tokens (default 1) from `userId`'s bucket for `action`,
 * refilling continuously since it was last touched. `count` > 1 is for a
 * single request that represents several units of the limited thing (an
 * upload batch of N files) — checked and consumed atomically, so a batch
 * either all counts or none of it does. */
export function checkLimit(
  action: LimitAction,
  userId: string,
  count = 1,
): LimitResult {
  const cfg = LIMITS[action];
  const now = Date.now();
  maybeSweep(now);

  const key = bucketKey(action, userId);
  let b = buckets.get(key);
  if (!b) {
    b = { tokens: cfg.capacity, updatedAt: now };
    buckets.set(key, b);
  }
  const elapsed = Math.max(0, now - b.updatedAt);
  b.tokens = Math.min(
    cfg.capacity,
    b.tokens + (elapsed / cfg.windowMs) * cfg.capacity,
  );
  b.updatedAt = now;

  if (b.tokens < count) {
    const deficit = count - b.tokens;
    const retryAfterMs = (deficit / cfg.capacity) * cfg.windowMs;
    return {
      allowed: false,
      retryAfter: Math.max(1, Math.ceil(retryAfterMs / 1000)),
    };
  }
  b.tokens -= count;
  return { allowed: true };
}

/** The HTTP shape of a refusal (docs/phases/5-hardening.md section 2):
 * `429 {reason, retryAfter}` plus a `Retry-After` header. */
export function tooManyRequests(
  res: ServerResponse,
  reason: string,
  retryAfter: number,
): void {
  res.setHeader('Retry-After', String(retryAfter));
  json(res, 429, { reason, retryAfter });
}

/** Test-only: drops every bucket, so a limits test doesn't depend on
 * import order or leak state into a later test's assertions. */
export function resetLimitsForTest(): void {
  buckets.clear();
  sinceSweep = 0;
}
