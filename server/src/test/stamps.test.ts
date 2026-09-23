import { describe, expect, test } from 'bun:test';
// sheets/stamps.ts: a claim's `made`/`edited` stamps are the server's word,
// not the client's. A client sends its whole scene on every emit, other
// people's claims included, so a stamp cannot simply be rewritten to the
// sender: a stamp the server signed is kept; any other is the sender's.
import { signStored, verifyStamps } from '../sheets/stamps.ts';

const sheet = 'sheet-1';
const alice = { id: 'alice', name: 'Alice' };
const bob = { id: 'bob', name: 'Bob' };
const now = Date.parse('2026-09-23T12:00:00Z');

type El = { id: string; customData?: Record<string, unknown> };

function region(id: string, made: Record<string, unknown>): El {
  return { id, customData: { kind: 'region', made } };
}

function stampOf(el: unknown, which: 'made' | 'edited') {
  return (el as El).customData?.[which] as Record<string, string>;
}

describe('stamps', () => {
  test('a forged stamp becomes the sender', () => {
    const [out] = verifyStamps(
      [
        region('r1', {
          id: 'alice',
          name: 'Alice',
          at: '2026-09-23T11:59:00Z',
        }),
      ],
      sheet,
      bob,
      now,
    );
    expect(stampOf(out, 'made')).toMatchObject({ id: 'bob', name: 'Bob' });
    expect(stampOf(out, 'made').sig).toBeString();
  });

  test('a stamp the server signed survives another user echoing it', () => {
    const [signed] = verifyStamps(
      [
        region('r1', {
          id: 'alice',
          name: 'Alice',
          at: '2026-09-23T11:59:00Z',
        }),
      ],
      sheet,
      alice,
      now,
    );
    const [echoed] = verifyStamps([signed], sheet, bob, now);
    expect(stampOf(echoed, 'made')).toMatchObject({
      id: 'alice',
      name: 'Alice',
    });
  });

  test('a signed stamp altered, or moved to another claim, is the sender again', () => {
    const [signed] = verifyStamps(
      [
        region('r1', {
          id: 'alice',
          name: 'Alice',
          at: '2026-09-23T11:59:00Z',
        }),
      ],
      sheet,
      alice,
      now,
    );
    const made = stampOf(signed, 'made');
    const renamed = region('r1', { ...made, name: 'Mallory' });
    const moved = region('r2', { ...made });
    const [a, b] = verifyStamps([renamed, moved], sheet, bob, now);
    expect(stampOf(a, 'made').id).toBe('bob');
    expect(stampOf(b, 'made').id).toBe('bob');
  });

  test('the same unsigned stamp signs the same way every emit; an implausible time becomes now', () => {
    const stamp = { id: 'alice', name: 'Alice', at: '2026-09-23T11:58:00Z' };
    const [first] = verifyStamps([region('r1', stamp)], sheet, alice, now);
    const [again] = verifyStamps(
      [region('r1', stamp)],
      sheet,
      alice,
      now + 5_000,
    );
    expect(stampOf(again, 'made')).toEqual(stampOf(first, 'made'));
    const [future] = verifyStamps(
      [region('r1', { ...stamp, at: '2030-01-01T00:00:00Z' })],
      sheet,
      alice,
      now,
    );
    expect(stampOf(future, 'made').at).toBe(new Date(now).toISOString());
  });

  test('elements without stamps, or that are not claims, pass untouched', () => {
    const image = { id: 'i1', customData: { kind: 'image', imageId: 'x' } };
    const bare = { id: 'b1' };
    expect(verifyStamps([image, bare], sheet, bob, now)).toEqual([image, bare]);
  });

  test('a stored stamp from before signing keeps its author when echoed', () => {
    const old = region('r1', {
      id: 'alice',
      name: 'Alice',
      at: '2026-09-01T10:00:00Z',
    });
    const [served] = signStored([old], sheet);
    const [echoed] = verifyStamps([served], sheet, bob, now);
    expect(stampOf(echoed, 'made')).toMatchObject({
      id: 'alice',
      at: '2026-09-01T10:00:00Z',
    });
  });
});
