// Polls the projection, not the scene — CONTEXT.md "Projection": "Seconds of
// lag, by design." A foreign claim reaches this sheet only after the owning
// sheet's snapshot debounce (1,500 ms) and this poll (<=3,000 ms), ~2.8s
// measured (docs/design.md numbers table).
import type { Foreign } from '@digsite/shared';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api.ts';

const POLL_MS = 3000;
const EMPTY: Foreign = { regions: [], edges: [] };

export function useForeign(sheetId: string): Foreign {
  const [rows, setRows] = useState<Foreign>(EMPTY);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const next = await api.getSheetForeign(sheetId);
        if (!cancelled) setRows(next);
      } catch {
        // server unreachable this tick; the next interval tries again
      }
    }

    void poll();
    const id = window.setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [sheetId]);

  return rows;
}
