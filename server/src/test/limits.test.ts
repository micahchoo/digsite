import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'node:http';
// Phase 5 section 2 (docs/phases/5-hardening.md "Abuse limits"): the token
// bucket itself (limits.ts), action-agnostic — the same function gates
// uploads, tus creates, socket connects and scene emits (limits.ts's own
// LIMITS table), so one bucket test covers the mechanism every one of
// those call sites relies on. The second test is the one HTTP-visible
// shape: `429 {reason, retryAfter}` with a `Retry-After` header, on the
// multipart upload route.
import type { AddressInfo } from 'node:net';
import { createCanvas } from '@napi-rs/canvas';
import { createHttpServer } from '../app.ts';
import { env } from '../env.ts';
import { checkLimit, resetLimitsForTest } from '../limits.ts';

describe('limits: token bucket', () => {
  test('allows up to capacity, then refuses with a retryAfter', () => {
    resetLimitsForTest();
    const userId = 'bucket-user-1';
    for (let i = 0; i < env.RATE_SCENE_EMIT_PER_SEC; i++) {
      const r = checkLimit('scene-emit', userId);
      expect(r.allowed).toBe(true);
    }
    const refused = checkLimit('scene-emit', userId);
    expect(refused.allowed).toBe(false);
    if (!refused.allowed) {
      expect(refused.retryAfter).toBeGreaterThan(0);
    }
  });

  test('a batch consumes N tokens atomically — a batch over the remaining balance is refused whole, not partially', () => {
    resetLimitsForTest();
    const userId = 'bucket-user-2';
    const over = env.RATE_UPLOAD_PER_MIN + 1;
    const r = checkLimit('upload', userId, over);
    expect(r.allowed).toBe(false);
    // The bucket is untouched by a refused batch — a same-size request
    // right after still finds a full bucket, not a partially-drained one.
    const retry = checkLimit('upload', userId, env.RATE_UPLOAD_PER_MIN);
    expect(retry.allowed).toBe(true);
  });

  test('buckets are per (user, action) — one user never affects another user or another action', () => {
    resetLimitsForTest();
    const a = checkLimit('upload', 'bucket-user-a', env.RATE_UPLOAD_PER_MIN);
    expect(a.allowed).toBe(true);
    const b = checkLimit('upload', 'bucket-user-b', env.RATE_UPLOAD_PER_MIN);
    expect(b.allowed).toBe(true); // a different user's bucket, untouched by a's
    const otherAction = checkLimit(
      'tus-create',
      'bucket-user-a',
      env.RATE_TUS_CREATE_PER_MIN,
    );
    expect(otherAction.allowed).toBe(true); // a different action's bucket for the same user
  });

  test('refills over time (not just on a fresh bucket)', async () => {
    resetLimitsForTest();
    const userId = 'bucket-user-refill';
    // Drain it, wait past a fraction of the window, confirm at least one
    // token came back — asserts refill happens continuously, not only at
    // bucket creation.
    checkLimit('scene-emit', userId, env.RATE_SCENE_EMIT_PER_SEC);
    const immediately = checkLimit('scene-emit', userId);
    expect(immediately.allowed).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 1100)); // > 1s window
    const afterWait = checkLimit('scene-emit', userId);
    expect(afterWait.allowed).toBe(true);
  });
});

describe('limits: HTTP shape', () => {
  let server: Server;
  let base = '';

  beforeAll(async () => {
    server = createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address() as AddressInfo;
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );

  function onePixelPng(): Buffer {
    const canvas = createCanvas(4, 4);
    canvas.getContext('2d').fillRect(0, 0, 4, 4);
    return canvas.encodeSync('png');
  }

  test('an exhausted upload bucket answers 429 {reason, retryAfter} with a Retry-After header', async () => {
    resetLimitsForTest();
    const ts = Date.now();
    let cookie = '';
    const signUp = await fetch(`${base}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `limits-${ts}@example.test`,
        password: 'password1234',
        name: 'limits',
      }),
    });
    const setCookie = signUp.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0] ?? '';
    const userId = ((await signUp.json()) as { user: { id: string } }).user.id;

    const group = await fetch(`${base}/groups`, {
      method: 'POST',
      headers: { Origin: base, cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `Limits-${ts}` }),
    });
    const groupId = ((await group.json()) as { id: string }).id;
    const board = await fetch(`${base}/groups/${groupId}/boards`, {
      method: 'POST',
      headers: { Origin: base, cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'B', open: true }),
    });
    const boardId = ((await board.json()) as { id: string }).id;

    // Drain this user's upload bucket directly — faster and more direct
    // than actually posting env.RATE_UPLOAD_PER_MIN files first.
    checkLimit('upload', userId, env.RATE_UPLOAD_PER_MIN);

    const form = new FormData();
    form.append(
      'files',
      new Blob([onePixelPng()], { type: 'image/png' }),
      'a.png',
    );
    const res = await fetch(`${base}/boards/${boardId}/images?wait=0`, {
      method: 'POST',
      headers: { Origin: base, cookie },
      body: form,
    });

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBeTruthy();
    const body = (await res.json()) as { reason: string; retryAfter: number };
    expect(body.reason).toBe('upload');
    expect(body.retryAfter).toBeGreaterThan(0);
  });
});
