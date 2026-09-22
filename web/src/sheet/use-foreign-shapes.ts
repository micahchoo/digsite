// The foreign poll (`overlay/useForeign.ts`) turned into scene-space shapes,
// kept both as a reactive value (the overlay/status line re-render on it)
// and as a ref (`tools.ts`'s `getForeignShapes` deps need a synchronous read
// that a `useMemo` value captured by a ONE-TIME closure — `use-sheet-tools.ts`'s
// `tools` — cannot give: it would freeze at whatever the memo was on the
// render that built `tools`). Split out of Sheet.tsx purely to keep that
// file at composition size (docs/phases/2-sheet.md section 7).
import { useEffect, useMemo, useRef } from 'react';
import type { SceneElement } from './canvas/types.ts';
import { foreignShapes } from './overlay/screen.ts';
import { useForeign } from './overlay/useForeign.ts';

export function useForeignShapes(
  sheetId: string,
  sceneElements: SceneElement[],
) {
  const rows = useForeign(sheetId);
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
