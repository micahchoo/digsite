// Pure: the copy ErrorState.tsx renders for each status (docs/ux/audit.md
// #1 — no fetch, no DOM). See ../src/components/ErrorState.tsx.
import { describe, expect, test } from 'bun:test';
import { describeError, fromCaught } from '../src/components/ErrorState.tsx';
import { ApiError } from '../src/lib/api.ts';

describe('describeError', () => {
  test('403 with no known creator falls back to a generic owner', () => {
    const content = describeError({ status: 403, resource: 'board' });
    expect(content.heading).toBe("You're not on this board's list.");
    expect(content.body).toBe("Ask this board's owner to add you.");
    expect(content.detail).toBeNull();
  });

  test('403 with a creator name names them', () => {
    const content = describeError({
      status: 403,
      resource: 'board',
      creatorName: 'Priya',
    });
    expect(content.body).toBe('Ask Priya to add you.');
  });

  test("403's server reason is shown, per docs/ux/audit.md #1", () => {
    const content = describeError({
      status: 403,
      resource: 'board',
      reason: 'not on this private board',
    });
    expect(content.detail).toBe('Reason: not on this private board');
  });

  test('404 names the resource and drops a bare "not found" reason', () => {
    const content = describeError({
      status: 404,
      resource: 'sheet',
      reason: 'not found',
    });
    expect(content.heading).toBe("This sheet doesn't exist.");
    expect(content.detail).toBeNull();
  });

  test('404 keeps a reason that says more than "not found"', () => {
    const content = describeError({
      status: 404,
      resource: 'group',
      reason: 'no longer open',
    });
    expect(content.detail).toBe('no longer open');
  });

  test('500 shows the request id as a reference, when present', () => {
    const content = describeError({
      status: 500,
      resource: 'board',
      requestId: 'req-abc123',
    });
    expect(content.detail).toBe('Reference: req-abc123');
  });

  test('500 with both a reason and a request id shows both', () => {
    const content = describeError({
      status: 500,
      resource: 'board',
      reason: 'internal error',
      requestId: 'req-xyz',
    });
    expect(content.detail).toBe('internal error — Reference: req-xyz');
  });

  test('500 with neither has no detail line', () => {
    const content = describeError({ status: 500, resource: 'board' });
    expect(content.detail).toBeNull();
  });

  test('a network failure (no response at all) gets its own copy', () => {
    const content = describeError({ status: 'network' });
    expect(content.heading).toBe("Couldn't reach the server.");
  });

  test('resource defaults to "page" when the call site has no better word', () => {
    const content = describeError({ status: 404 });
    expect(content.heading).toBe("This page doesn't exist.");
  });
});

describe('fromCaught', () => {
  test('an ApiError carries its status, reason and requestId through', () => {
    const err = new ApiError(403, 'not on the allowlist', 'req-1');
    const info = fromCaught(err, 'board', 'Priya');
    expect(info).toEqual({
      status: 403,
      reason: 'not on the allowlist',
      requestId: 'req-1',
      resource: 'board',
      creatorName: 'Priya',
    });
  });

  test('anything that is not an ApiError (fetch itself rejecting) is "network"', () => {
    const info = fromCaught(new TypeError('Failed to fetch'), 'sheet');
    expect(info.status).toBe('network');
    expect(info.resource).toBe('sheet');
  });
});
