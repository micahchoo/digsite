// "Copy connections" (docs/phases/2-sheet.md section 4): `POST
// /boards/:id/sheets`'s neighbourhood edges, passed through
// `navigate(..., {state})` from Board.tsx's Explore panel, applied once the
// new sheet's own scene has loaded. By imageId, not element id: this
// sheet's own image elements' ids are a server/stub implementation detail
// no caller has business assuming. Every edge this creates is an ordinary
// OWN edge from the moment it exists — nothing here is foreign.
import { dataOf } from '@digsite/shared';
import type { Direction } from '@digsite/shared';
import { useEffect, useRef } from 'react';
import type { SceneElement } from './canvas/types.ts';
import type { Tools } from './tools.ts';

export interface PendingCopyEdge {
  sourceImageId: string;
  targetImageId: string;
  relation: string;
  direction: Direction;
}

export function useCopyConnections(
  pending: PendingCopyEdge[] | undefined,
  sceneElements: SceneElement[],
  tools: Tools,
  onApplied: () => void,
): void {
  const appliedRef = useRef(false);
  useEffect(() => {
    if (!pending?.length || appliedRef.current || !sceneElements.length) return;
    appliedRef.current = true;
    const imageElByImageId = new Map<string, SceneElement>();
    for (const el of tools.getElements()) {
      const data = dataOf(el);
      if (data?.kind === 'image') imageElByImageId.set(data.imageId, el);
    }
    for (const edge of pending) {
      const fromEl = imageElByImageId.get(edge.sourceImageId);
      const toEl = imageElByImageId.get(edge.targetImageId);
      if (fromEl && toEl)
        tools.connect(fromEl.id, toEl.id, edge.relation, edge.direction);
    }
    onApplied();
  }, [sceneElements, tools, onApplied, pending]);
}
