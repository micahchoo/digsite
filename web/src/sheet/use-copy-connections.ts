// Runs "Copy connections" (actions.ts#copyConnections) once, when the new
// sheet's own scene has loaded. The edges come from Board.tsx's Explore
// panel through `navigate(..., {state})`.
import { useEffect, useRef } from 'react';
import type { PendingCopyEdge, SheetActions } from './actions.ts';
import type { SceneElement } from './canvas/types.ts';

export function useCopyConnections(
  pending: PendingCopyEdge[] | undefined,
  sceneElements: SceneElement[],
  actions: SheetActions,
): void {
  const doneRef = useRef(false);
  useEffect(() => {
    if (!pending?.length || doneRef.current || !sceneElements.length) return;
    doneRef.current = true;
    actions.copyConnections(pending);
  }, [sceneElements, actions, pending]);
}
