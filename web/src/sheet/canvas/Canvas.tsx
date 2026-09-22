// The seam's one entry point (../../../.claude/rules/sheet-canvas-seam.md):
// a switch between two adapters, both satisfying `CanvasProps`/`CanvasHandle`
// (types.ts) with no Excalidraw import outside `excalidraw/` and no
// `@digsite`-external drawing engine outside `native/` — the seam linter's
// `except: web/src/sheet/canvas/` covers this whole directory, both
// subdirectories included.
//
// `VITE_CANVAS=excalidraw|native` picks the default (excalidraw, until the
// native one passes every smoke/e2e suite — docs/phases/2-sheet.md section
// 8); `?canvas=native` or `?canvas=excalidraw` on a sheet URL overrides it
// for one session, read once at mount, so switching mid-session means a
// reload rather than a live swap (the two adapters don't share engine
// state, only the persisted element JSON).
import { forwardRef, useState } from 'react';
import { ExcalidrawCanvas } from './excalidraw/ExcalidrawCanvas.tsx';
import { NativeCanvas } from './native/index.ts';
import type { CanvasHandle, CanvasProps } from './types.ts';

export type Adapter = 'excalidraw' | 'native';

function resolveAdapter(): Adapter {
  if (typeof window !== 'undefined') {
    const q = new URLSearchParams(window.location.search).get('canvas');
    if (q === 'native' || q === 'excalidraw') return q;
  }
  const env =
    (import.meta.env.VITE_CANVAS as string | undefined)?.toLowerCase() ??
    'excalidraw';
  return env === 'native' ? 'native' : 'excalidraw';
}

export const Canvas = forwardRef<CanvasHandle, CanvasProps>(
  function Canvas(props, ref) {
    // Resolved once per mount (lazy useState initialiser, not read on every
    // render): a component instance never switches adapters mid-life, but a
    // fresh mount (a different sheet's URL, a full navigation) re-reads the
    // URL param and env var correctly rather than sticking to whatever the
    // first sheet this session ever opened resolved to.
    const [adapter] = useState<Adapter>(resolveAdapter);
    return adapter === 'native' ? (
      <NativeCanvas ref={ref} {...props} />
    ) : (
      <ExcalidrawCanvas ref={ref} {...props} />
    );
  },
);
