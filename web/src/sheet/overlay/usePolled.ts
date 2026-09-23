// A value read from the projection on an interval (CONTEXT.md "Projection":
// "Seconds of lag, by design"). A failed read keeps the last answer; the
// next tick tries again. `refresh` reads now, after a change this page made.
import { useCallback, useEffect, useRef, useState } from 'react';

export const POLL_MS = 3000;

export function usePolled<T>(
  key: string,
  read: (key: string) => Promise<T>,
  empty: T,
): { value: T; refresh: () => void } {
  const [value, setValue] = useState<T>(empty);
  const readRef = useRef(read);
  readRef.current = read;
  const generation = useRef(0);

  const poll = useCallback(async (k: string, gen: number) => {
    try {
      const next = await readRef.current(k);
      if (gen === generation.current) setValue(next);
    } catch {
      // server unreachable this tick; the next interval tries again
    }
  }, []);

  useEffect(() => {
    const gen = ++generation.current;
    if (!key) return;
    void poll(key, gen);
    const id = window.setInterval(() => void poll(key, gen), POLL_MS);
    return () => window.clearInterval(id);
  }, [key, poll]);

  const refresh = useCallback(() => {
    if (key) void poll(key, generation.current);
  }, [key, poll]);
  return { value, refresh };
}
