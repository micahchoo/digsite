// Our four tools plus our own zoom/undo/redo, replacing Excalidraw's stock
// toolbar and footer wholesale (docs/phases/2-sheet.md section 1;
// canvas/README.md — `ui={false}` is what took the stock ones away). select/
// pan map straight onto Excalidraw's own tools; region/edge are ours
// (Sheet.tsx wires them to `{type: 'custom', customType}` via
// `tools.setTool`, per research/excalidraw: a custom tool gets no built-in
// pointer behaviour at all, so nothing here fights our own drag handling in
// DrawLayer.tsx). Zoom/undo/redo talk to the canvas seam's handle directly —
// this component is the one place outside `canvas/` allowed to import its
// TYPE (not the `@excalidraw` package, never that).
import { useEffect } from 'react';
import type { CanvasHandle } from './canvas/types.ts';
import type { Tool } from './gestures.ts';

interface Props {
  tool: Tool;
  onChange: (tool: Tool) => void;
  pendingEdge: boolean;
  canvas: CanvasHandle | null;
}

const TOOLS: { tool: Tool; label: string; key: string }[] = [
  { tool: 'select', label: 'Select', key: 'v' },
  { tool: 'region', label: 'Region', key: 'r' },
  { tool: 'edge', label: 'Edge', key: 'e' },
  { tool: 'pan', label: 'Pan', key: 'h' },
];

/** True while an input/textarea/contenteditable — including Excalidraw's
 * own bound-text editor — has focus, so a shortcut key does not steal a
 * letter the owner is typing. */
function typing(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    (el as HTMLElement).isContentEditable === true
  );
}

export function Toolbar({ tool, onChange, pendingEdge, canvas }: Props) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (typing() || e.metaKey || e.ctrlKey || e.altKey) return;
      const match = TOOLS.find((t) => t.key === e.key.toLowerCase());
      if (match) onChange(match.tool);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onChange]);

  return (
    // Bottom-centre, not the scene's default top-left corner: at scroll 0
    // the seed grid's row 0 sits under (0,0) and a top-left toolbar
    // overlaps it (docs/phases/2-sheet.md's prior step found this).
    <div data-testid="sheet-toolbar" className="sheet-toolbar">
      {TOOLS.map((t) => (
        <button
          key={t.tool}
          type="button"
          data-testid={`tool-${t.tool}`}
          aria-pressed={tool === t.tool}
          onClick={() => onChange(t.tool)}
          title={`${t.label} (${t.key.toUpperCase()})`}
          className={
            tool === t.tool
              ? 'sheet-toolbar-btn sheet-toolbar-btn--active'
              : 'sheet-toolbar-btn'
          }
        >
          {t.label}
        </button>
      ))}
      {tool === 'edge' && pendingEdge && (
        <span data-testid="edge-pending" className="sheet-toolbar-hint">
          pick a target… (Esc to cancel)
        </span>
      )}
      <span className="sheet-toolbar-sep" aria-hidden="true" />
      <button
        type="button"
        data-testid="zoom-out"
        title="Zoom out"
        className="sheet-toolbar-btn"
        onClick={() => canvas?.zoomBy(1 / 1.2)}
      >
        −
      </button>
      <button
        type="button"
        data-testid="zoom-fit"
        title="Zoom to fit"
        className="sheet-toolbar-btn"
        onClick={() => canvas?.zoomToFit()}
      >
        fit
      </button>
      <button
        type="button"
        data-testid="zoom-in"
        title="Zoom in"
        className="sheet-toolbar-btn"
        onClick={() => canvas?.zoomBy(1.2)}
      >
        +
      </button>
      <span className="sheet-toolbar-sep" aria-hidden="true" />
      <button
        type="button"
        data-testid="undo"
        title="Undo (Ctrl/Cmd+Z)"
        className="sheet-toolbar-btn"
        onClick={() => canvas?.undo()}
      >
        ↶
      </button>
      <button
        type="button"
        data-testid="redo"
        title="Redo (Ctrl/Cmd+Shift+Z)"
        className="sheet-toolbar-btn"
        onClick={() => canvas?.redo()}
      >
        ↷
      </button>
    </div>
  );
}
