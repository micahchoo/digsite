// CONTEXT.md "Stamp": who made or last changed a claim, and when. The
// client writes a stamp when its user draws or changes a region or edge;
// the server makes it true.
//
// A client emits its WHOLE scene every time, other people's claims
// included, so the sender cannot simply be written into every stamp. And
// rooms span processes, so a per-room memory of who stamped what would be
// partial. Instead the server signs: a stamp arrives either with a valid
// signature (it passed through the server before, as someone's) and is
// kept, or without one — new, or forged — and is rewritten to the sender
// and signed. The signature binds the sheet, the element and which stamp it
// is, so it cannot be moved to another claim or altered.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../env.ts';

export type Person = { id: string; name: string };

const KINDS = ['made', 'edited'] as const;
// A new stamp keeps the client's time if it is plausible, so the same stamp
// signs the same way on every emit (the sender never receives the signed
// copy back); otherwise it takes the server's.
const PAST_MS = 10 * 60_000;
const FUTURE_MS = 60_000;

function sign(
  sheetId: string,
  elementId: string,
  kind: string,
  stamp: { id: string; name: string; at: string },
): string {
  return createHmac('sha256', env.AUTH_SECRET)
    .update(
      JSON.stringify([
        sheetId,
        elementId,
        kind,
        stamp.id,
        stamp.name,
        stamp.at,
      ]),
    )
    .digest('base64url')
    .slice(0, 22);
}

function signedBy(
  sheetId: string,
  elementId: string,
  kind: string,
  stamp: Record<string, unknown>,
): boolean {
  if (
    typeof stamp.id !== 'string' ||
    typeof stamp.name !== 'string' ||
    typeof stamp.at !== 'string' ||
    typeof stamp.sig !== 'string'
  )
    return false;
  const want = Buffer.from(
    sign(
      sheetId,
      elementId,
      kind,
      stamp as { id: string; name: string; at: string },
    ),
  );
  const got = Buffer.from(stamp.sig);
  return got.length === want.length && timingSafeEqual(got, want);
}

function plausibleTime(at: unknown, now: number): string {
  const t = typeof at === 'string' ? Date.parse(at) : Number.NaN;
  if (Number.isFinite(t) && t >= now - PAST_MS && t <= now + FUTURE_MS)
    return new Date(t).toISOString();
  return new Date(now).toISOString();
}

/** The elements as the server vouches for them: every stamp either carries
 * the server's signature or now names `sender`. Elements without stamps
 * pass through as they came. */
export function verifyStamps(
  elements: unknown[],
  sheetId: string,
  sender: Person,
  now: number = Date.now(),
): unknown[] {
  return elements.map((element) => {
    const el = element as { id?: unknown; customData?: unknown };
    const data = el?.customData;
    if (typeof el?.id !== 'string' || typeof data !== 'object' || data === null)
      return element;
    const record = data as Record<string, unknown>;
    let changed: Record<string, unknown> | null = null;
    for (const kind of KINDS) {
      const stamp = record[kind];
      if (typeof stamp !== 'object' || stamp === null) continue;
      const fields = stamp as Record<string, unknown>;
      if (signedBy(sheetId, el.id, kind, fields)) continue;
      const vouched = {
        id: sender.id,
        name: sender.name,
        at: plausibleTime(fields.at, now),
      };
      changed ??= { ...record };
      changed[kind] = { ...vouched, sig: sign(sheetId, el.id, kind, vouched) };
    }
    return changed ? { ...(element as object), customData: changed } : element;
  });
}

/** A stored scene as handed to a client: every stamp signed AS STORED.
 * Stamps saved before the server signed them were accepted then and cannot
 * be checked now; without this, the first person to echo an old claim would
 * be taken for its author. Signed ones pass through unchanged. */
export function signStored(elements: unknown[], sheetId: string): unknown[] {
  return elements.map((element) => {
    const el = element as { id?: unknown; customData?: unknown };
    const data = el?.customData;
    if (typeof el?.id !== 'string' || typeof data !== 'object' || data === null)
      return element;
    const record = data as Record<string, unknown>;
    let changed: Record<string, unknown> | null = null;
    for (const kind of KINDS) {
      const stamp = record[kind] as Record<string, unknown> | undefined;
      if (
        typeof stamp !== 'object' ||
        stamp === null ||
        typeof stamp.id !== 'string' ||
        typeof stamp.name !== 'string' ||
        typeof stamp.at !== 'string' ||
        signedBy(sheetId, el.id, kind, stamp)
      )
        continue;
      const kept = { id: stamp.id, name: stamp.name, at: stamp.at };
      changed ??= { ...record };
      changed[kind] = { ...kept, sig: sign(sheetId, el.id, kind, kept) };
    }
    return changed ? { ...(element as object), customData: changed } : element;
  });
}
