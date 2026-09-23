// Polls the projection, not the scene — CONTEXT.md "Projection": "Seconds of
// lag, by design." A foreign claim reaches this sheet only after the owning
// sheet's snapshot debounce (1,500 ms) and this poll (<=3,000 ms), ~2.8s
// measured (docs/design.md numbers table).
import type { Foreign } from '@digsite/shared';
import { api } from '../../lib/api.ts';
import { usePolled } from './usePolled.ts';

const EMPTY: Foreign = { regions: [], edges: [] };

export function useForeign(sheetId: string): Foreign {
  return usePolled(sheetId, api.getSheetForeign, EMPTY).value;
}
