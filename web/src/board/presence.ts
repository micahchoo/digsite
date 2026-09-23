// Who else is on this board, and what they point at (docs/phases/6-product.md
// "Presence on the board by image"): their hovered and selected pictures as
// outlines in their colour, with a name on the hover. The server relays over
// the sheet rooms' socket (shared/api.ts BoardPresencePayload); a viewer is a
// socket, so one person with two tabs is two viewers with one colour.
//
// Only picture ids travel. Where a picture sits is a rank under THIS viewer's
// sort, so the page turns ids into ranks through its ranked view.
import type {
  BoardPresencePayload,
  PresenceUpdatePayload,
  PresenceViewer,
} from '@digsite/shared';
import { useEffect, useRef, useState } from 'react';
import { type Socket, io } from 'socket.io-client';
import { SERVER_ORIGIN } from '../lib/api.ts';

/** The server relays at most this many updates a second, and drops the rest. */
const SEND_EVERY_MS = 200;
/** And cuts a selection to this many. */
export const SELECTED_MAX = 200;

/** The viewers after a message: a full list replaces, a single viewer is
 * merged by key (an empty selection and no hover keeps them listed). Never
 * this tab itself. */
export function mergePresence(
  current: readonly PresenceViewer[],
  payload: BoardPresencePayload,
  selfKey: string | undefined,
): PresenceViewer[] {
  const others = (v: PresenceViewer) => v.key !== selfKey;
  if (payload.full) return payload.viewers.filter(others);
  const next = [...current];
  for (const v of payload.viewers.filter(others)) {
    const at = next.findIndex((x) => x.key === v.key);
    if (at >= 0) next[at] = v;
    else next.push(v);
  }
  return next;
}

/** Every picture another viewer points at, once each. */
export function pointedAt(viewers: readonly PresenceViewer[]): string[] {
  const ids = new Set<string>();
  for (const v of viewers) {
    if (v.hover) ids.add(v.hover);
    for (const id of v.selected) ids.add(id);
  }
  return [...ids].sort();
}

export interface Outline {
  rank: number;
  colour: [number, number, number];
  /** The hover carries its viewer's name; a selection does not. */
  name: string | null;
}

/** The outlines to draw: each viewer's selection, and their hover named. A
 * picture this sort has no rank for is left out. */
export function outlinesOf(
  viewers: readonly PresenceViewer[],
  rankOf: ReadonlyMap<string, number>,
): Outline[] {
  const out: Outline[] = [];
  for (const v of viewers) {
    const colour = rgbOf(v.colour);
    for (const id of v.selected) {
      const rank = rankOf.get(id);
      if (rank !== undefined) out.push({ rank, colour, name: null });
    }
    const hovered = v.hover ? rankOf.get(v.hover) : undefined;
    if (hovered !== undefined)
      out.push({ rank: hovered, colour, name: v.name });
  }
  return out;
}

/** `hsl(h, s%, l%)` (what the server sends) or `#rrggbb` as RGB for deck.gl;
 * a neutral grey for anything else. */
export function rgbOf(colour: string): [number, number, number] {
  const hex = colour.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (hex)
    return [
      Number.parseInt(hex[1] ?? '0', 16),
      Number.parseInt(hex[2] ?? '0', 16),
      Number.parseInt(hex[3] ?? '0', 16),
    ];
  const hsl = colour.match(
    /^hsl\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%\s*\)$/i,
  );
  if (!hsl) return [128, 128, 128];
  const h = Number(hsl[1]) / 360;
  const s = Number(hsl[2]) / 100;
  const l = Number(hsl[3]) / 100;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t0: number) => {
    const t = t0 < 0 ? t0 + 1 : t0 > 1 ? t0 - 1 : t0;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [channel(h + 1 / 3), channel(h), channel(h - 1 / 3)].map((c) =>
    Math.round(c * 255),
  ) as [number, number, number];
}

/**
 * Joins the board's presence and says what this viewer points at, at most
 * five times a second, the last word always sent. The other viewers, and why
 * joining was refused if it was.
 */
export function useBoardPresence(
  boardId: string,
  hover: string | null,
  selected: readonly string[],
): { viewers: PresenceViewer[]; denied: string | null } {
  const [viewers, setViewers] = useState<PresenceViewer[]>([]);
  const [denied, setDenied] = useState<string | null>(null);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    setViewers([]);
    setDenied(null);
    const socket = io(SERVER_ORIGIN, { withCredentials: true });
    socketRef.current = socket;
    const join = () => socket.emit('board-join', { boardId });
    socket.on('connect', join);
    socket.on('presence', (payload: BoardPresencePayload) =>
      setViewers((current) => mergePresence(current, payload, socket.id)),
    );
    socket.on('board-join-denied', ({ reason }: { reason: string }) =>
      setDenied(reason),
    );
    return () => {
      socket.emit('board-leave');
      socket.close();
      socketRef.current = null;
    };
  }, [boardId]);

  // What this viewer points at, sent no more often than the server relays.
  const said = JSON.stringify([hover, selected.slice(0, SELECTED_MAX)]);
  const lastSent = useRef({ at: 0, said: '' });
  useEffect(() => {
    const send = () => {
      const socket = socketRef.current;
      if (!socket?.connected || lastSent.current.said === said) return;
      const [h, s] = JSON.parse(said) as [string | null, string[]];
      const update: PresenceUpdatePayload = { hover: h, selected: s };
      socket.emit('board-presence', update);
      lastSent.current = { at: Date.now(), said };
    };
    const wait = SEND_EVERY_MS - (Date.now() - lastSent.current.at);
    if (wait <= 0) {
      send();
      return;
    }
    const timer = window.setTimeout(send, wait);
    return () => window.clearTimeout(timer);
  }, [said]);

  return { viewers, denied };
}
