// The foreign poll turned into scene-space shapes, computed once here,
// kept both as a reactive value (the overlay/status line re-render on it)
// and as a ref (`tools.ts`'s `getForeignShapes` deps need a synchronous read
// that a `useMemo` value captured by a ONE-TIME closure — `use-sheet-tools.ts`'s
// `tools` — cannot give: it would freeze at whatever the memo was on the
// render that built `tools`). Split out of Sheet.tsx purely to keep that
// file at composition size (docs/phases/2-sheet.md section 7).
import type { Foreign } from '@digsite/shared';
import { useEffect, useMemo, useRef } from 'react';
import { api } from '../lib/api.ts';
import type { SceneElement } from './canvas/types.ts';
import { foreignShapes } from './overlay/screen.ts';
import { usePolled } from './overlay/usePolled.ts';

// Polls the projection, not the scene (CONTEXT.md "Projection": seconds of
// lag, by design): the owning sheet's snapshot debounce plus this poll.
const NO_FOREIGN: Foreign = { regions: [], edges: [] };

export function useForeignShapes(
  sheetId: string,
  sceneElements: SceneElement[],
) {
  const rows = usePolled(sheetId, api.getSheetForeign, NO_FOREIGN).value;
  const shapes = useMemo(
    () => foreignShapes(rows, sceneElements),
    [rows, sceneElements],
  );
  const ref = useRef<ReturnType<typeof foreignShapes>>([]);
  useEffect(() => {
    ref.current = shapes;
  }, [shapes]);
  return { rows, shapes, ref };
}
