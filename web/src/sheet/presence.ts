// Presence (docs/phases/2-sheet.md section 3): pointer throttling and peer
// colour/outline geometry. Pure — no socket, no DOM, no canvas import —
// so it is unit-testable standalone; Sheet.tsx owns the socket and the
// pointermove listener, Overlay.tsx draws what this file computes.
import type { PointerBroadcastPayload } from '@digsite/shared/api';
import type { ElementLike, Rect } from './overlay/screen.ts';

// Server-enforced too (server/src/sheets/room.ts's POINTER_RATE_PER_S) —
// this is the CLIENT's own throttle, so a fast pointermove stream never
// even reaches the socket, let alone the server's drop-extras gate.
export const POINTER_RATE_PER_S = 20;

/** True if a pointer event at `now` may be sent, given when the last one
 * was (`lastSentAt`, or null for "never yet") — a fixed minimum interval,
 * the simplest throttle that guarantees at most `maxPerSecond` sends. */
export function canSendPointer(
  now: number,
  lastSentAt: number | null,
  maxPerSecond: number = POINTER_RATE_PER_S,
): boolean {
  if (lastSentAt === null) return true;
  return now - lastSentAt >= 1000 / maxPerSecond;
}

/** A peer whose name we don't know YET — room.ts's 'joined' handler sets it
 * to `''` until the very next 'peers' broadcast fills it in — is dropped,
 * never shown. docs/ux/audit.md #11: before this, that same handler used
 * the peer's raw user id as a placeholder name, and a screenshot taken in
 * that brief window caught it, e.g. "YbFKWrYrhDdOtPZSUKVNJerfMTQzjSCE" in
 * the presence strip. `SidePanel.tsx#Header` is the one caller. Pure. */
export function namedPeers<T extends { name: string }>(peers: T[]): T[] {
  return peers.filter((p) => p.name);
}

/** A deterministic colour from a user id — the same id always draws the
 * same colour, on every peer's screen, every render (docs/phases/2-sheet.md
 * section 3: "in a colour from the user id"). */
export function colorForUser(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 31 + userId.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 70%, 45%)`;
}

export interface PeerCursor {
  user: string;
  name: string;
  x: number;
  y: number;
  color: string;
  /** The CURRENT rect of every element in the peer's last-reported
   * selection that still exists in the scene — recomputed from `elements`
   * every call, never cached from an earlier payload (the same discipline
   * as overlay/screen.ts#foreignShapes). */
  rects: Rect[];
}

function rectOf(el: ElementLike): Rect {
  return { x: el.x, y: el.y, width: el.width, height: el.height };
}

/** Every live peer's cursor and selection outline, in scene space. */
export function peerCursors(
  peers: readonly PointerBroadcastPayload[],
  elements: readonly ElementLike[],
): PeerCursor[] {
  return peers.map((p) => {
    const rects: Rect[] = [];
    for (const id of p.selectedIds) {
      const el = elements.find((e) => e.id === id && !e.isDeleted);
      if (el) rects.push(rectOf(el));
    }
    return {
      user: p.user,
      name: p.name,
      x: p.x,
      y: p.y,
      color: colorForUser(p.user),
      rects,
    };
  });
}
