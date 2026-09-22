// Our four tools, replacing Excalidraw's stock shape toolbar
// (docs/phases/2-sheet.md section 1). Excalidraw 0.18 has no UIOptions flag
// for hiding individual shape tools (`tools` only supports `{ image }` —
// checked against research/excalidraw/packages/excalidraw/types.ts) so the
// stock toolbar is hidden by CSS instead (`.shapes-section` in Sheet.tsx's
// wrapper), which leaves the zoom controls and undo/redo footer — separate
// `Section`s in LayerUI.tsx — alone.
//
// select/pan map straight onto Excalidraw's own tools; region/edge are ours
// (Sheet.tsx wires them to `{type: 'custom', customType}` via
// `tools.setTool`, per research/excalidraw: a custom tool gets no built-in
// pointer behaviour at all, so nothing here fights our own drag handling in
// DrawLayer.tsx).
import { useEffect } from 'react';
import type { Tool } from './gestures.ts';

interface Props {
  tool: Tool;
  onChange: (tool: Tool) => void;
  pendingEdge: boolean;
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

export function Toolbar({ tool, onChange, pendingEdge }: Props) {
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
    <div
      data-testid="sheet-toolbar"
      className="row"
      style={{
        position: 'absolute',
        top: 8,
        left: 8,
        zIndex: 5, // above Excalidraw's own layerUI (--zIndex-layerUI: 4)
        background: 'rgba(255,255,255,0.95)',
        border: '1px solid #ccc',
        borderRadius: 6,
        padding: 4,
        gap: 4,
      }}
    >
      {TOOLS.map((t) => (
        <button
          key={t.tool}
          type="button"
          data-testid={`tool-${t.tool}`}
          aria-pressed={tool === t.tool}
          onClick={() => onChange(t.tool)}
          title={`${t.label} (${t.key.toUpperCase()})`}
          style={{
            fontWeight: tool === t.tool ? 700 : 400,
            background: tool === t.tool ? '#1971c2' : 'transparent',
            color: tool === t.tool ? '#fff' : '#000',
            border: '1px solid #ccc',
            borderRadius: 4,
            padding: '4px 8px',
          }}
        >
          {t.label}
        </button>
      ))}
      {tool === 'edge' && pendingEdge && (
        <span
          className="muted"
          data-testid="edge-pending"
          style={{ marginLeft: 6 }}
        >
          pick a target… (Esc to cancel)
        </span>
      )}
    </div>
  );
}
