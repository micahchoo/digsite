// A wheel handler that may call `preventDefault`. React attaches `onWheel`
// as a PASSIVE listener, so a React handler cannot stop the browser: over a
// sheet a Ctrl+wheel or a trackpad pinch zoomed the whole page as well as
// the canvas, and in a report file a wheel over the live figure scrolled
// the document while it zoomed the sheet. This attaches the listener to the
// element itself with `passive: false`.
//
// Takes a ref for an element that stays mounted, or the element itself for
// one that remounts (Compare's panes, as its mode changes), so it gets its
// listener again.
import { type RefObject, useEffect, useRef } from 'react';

export function useWheel(
  target: Element | null | RefObject<Element | null>,
  /** Handed the element it listens on, the event's currentTarget. */
  handler: (event: WheelEvent, element: Element) => void,
): void {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    const element =
      target && 'current' in target
        ? target.current
        : (target as Element | null);
    if (!element) return;
    const listen = (event: Event) =>
      latest.current(event as WheelEvent, element);
    element.addEventListener('wheel', listen, { passive: false });
    return () => element.removeEventListener('wheel', listen);
  }, [target]);
}
