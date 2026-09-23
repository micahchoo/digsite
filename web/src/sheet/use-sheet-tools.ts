// Wires window.__digsite / window.__digsiteSheetDebug (e2e/smoke's fixed
// contract — names and behaviour unchanged by the canvas split) and owns
// the two small bits of state `tools.ts`'s deps need to read
// SYNCHRONOUSLY, off a ref rather than React state (the active tool, the
// foreign selection). Split out of Sheet.tsx purely to keep that file at
// composition size (docs/phases/2-sheet.md section 7).
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CanvasHandle } from './canvas/types.ts';
import type { Tool } from './gestures.ts';
import type { ForeignShape } from './overlay/screen.ts';
import { type SyncStatus, type Tools, createTools } from './tools.ts';

export interface UseSheetToolsDeps {
  sheetId: string;
  getHandle: () => CanvasHandle | null;
  getForeignShapes: () => ForeignShape[];
  getSyncStatus: () => SyncStatus;
  onRenamed: (name: string) => void;
  /** Who is signed in, for the stamps on a claim. */
  getAuthor?: () => { id: string; name: string } | null;
}

export interface SheetTools {
  tools: Tools;
  tool: Tool;
  setTool: (t: Tool) => void;
  selectedForeignId: string | null;
}

export function useSheetTools(deps: UseSheetToolsDeps): SheetTools {
  const {
    sheetId,
    getHandle,
    getForeignShapes,
    getSyncStatus,
    onRenamed,
    getAuthor,
  } = deps;
  const toolRef = useRef<Tool>('select');
  const [tool, setToolState] = useState<Tool>('select');
  const selectedForeignRef = useRef<string | null>(null);
  const [selectedForeignId, setSelectedForeignIdState] = useState<
    string | null
  >(null);

  const setTool = useCallback((next: Tool) => {
    toolRef.current = next;
    setToolState(next);
  }, []);
  const setSelectedForeign = useCallback((sid: string | null) => {
    selectedForeignRef.current = sid;
    setSelectedForeignIdState(sid);
  }, []);

  const toolsRef = useRef<Tools | null>(null);
  if (!toolsRef.current) {
    toolsRef.current = createTools({
      getHandle,
      getForeignShapes,
      getSelectedForeignId: () => selectedForeignRef.current,
      setSelectedForeign,
      getSyncStatus,
      getTool: () => toolRef.current,
      setTool,
      getSheetId: () => sheetId,
      onRenamed,
      getAuthor,
    });
  }
  const tools = toolsRef.current;

  useEffect(() => {
    window.__digsite = tools;
  }, [tools]);
  // Debug-only, NOT part of the fixed window.__digsite contract — e2e
  // scenario 8 (../.claude/rules/foreign-never-in-scene.md) reads
  // `.selectedElementIds`, `smoke-draw.ts#viewport` reads
  // `.scrollX`/`.scrollY`/`.zoom.value` — both the same way they did before
  // the split, now sourced from `CanvasHandle` instead of an engine API
  // appState directly.
  useEffect(() => {
    window.__digsiteSheetDebug = {
      getAppState: () => {
        const handle = getHandle();
        const vp = handle?.viewport() ?? { scrollX: 0, scrollY: 0, zoom: 1 };
        return {
          scrollX: vp.scrollX,
          scrollY: vp.scrollY,
          zoom: { value: vp.zoom },
          selectedElementIds: Object.fromEntries(
            (handle?.selectedIds() ?? []).map((id) => [id, true]),
          ),
        };
      },
    };
  }, [getHandle]);

  return { tools, tool, setTool, selectedForeignId };
}

declare global {
  interface Window {
    __digsiteSheetDebug?: {
      getAppState: () => {
        scrollX: number;
        scrollY: number;
        zoom: { value: number };
        selectedElementIds: Record<string, boolean>;
      } | null;
    };
  }
}
