// Our four tools plus zoom, undo and redo. Every action goes through the
// canvas handle; region/edge drawing is handled by DrawLayer.tsx.
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

function ToolIcon({
  name,
}: { name: Tool | 'zoom-out' | 'zoom-in' | 'fit' | 'undo' | 'redo' }) {
  const common = {
    viewBox: '0 0 20 20',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.65,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className: 'sheet-toolbar-icon',
    'aria-hidden': true as const,
  };
  switch (name) {
    case 'select':
      return (
        <svg {...common} aria-hidden="true">
          <path d="m5 3 9 8-4 .5 2 4-2 1-2-4-3 2z" />
        </svg>
      );
    case 'region':
      return (
        <svg {...common} aria-hidden="true">
          <rect
            x="3.5"
            y="4"
            width="13"
            height="12"
            rx="1.5"
            strokeDasharray="2 2"
          />
        </svg>
      );
    case 'edge':
      return (
        <svg {...common} aria-hidden="true">
          <path d="M3 15 14 4m0 0h-5m5 0v5m-2 4 4 3" />
        </svg>
      );
    case 'pan':
      return (
        <svg {...common} aria-hidden="true">
          <path d="M7 10V5.5a1.5 1.5 0 0 1 3 0V9m0-2a1.5 1.5 0 0 1 3 0v3m0-1a1.5 1.5 0 0 1 3 0v4a5 5 0 0 1-5 5h-1.5a4 4 0 0 1-3.2-1.6L4 13.5a1.4 1.4 0 0 1 2.1-1.8L7 13" />
        </svg>
      );
    case 'zoom-out':
      return (
        <svg {...common} aria-hidden="true">
          <circle cx="8.5" cy="8.5" r="5.5" />
          <path d="M6 8.5h5m1.5 4 4 4" />
        </svg>
      );
    case 'zoom-in':
      return (
        <svg {...common} aria-hidden="true">
          <circle cx="8.5" cy="8.5" r="5.5" />
          <path d="M6 8.5h5m-2.5-2.5v5m4-1 4 4" />
        </svg>
      );
    case 'fit':
      return (
        <svg {...common} aria-hidden="true">
          <path d="M7 3H3v4m10-4h4v4M3 13v4h4m10-4v4h-4" />
        </svg>
      );
    case 'undo':
      return (
        <svg {...common} aria-hidden="true">
          <path d="M7 7 3.5 10.5 7 14M4 10.5h6a5 5 0 0 1 5 5" />
        </svg>
      );
    case 'redo':
      return (
        <svg {...common} aria-hidden="true">
          <path d="m13 7 3.5 3.5L13 14m3-3.5h-6a5 5 0 0 0-5 5" />
        </svg>
      );
  }
}

/** True while an input/textarea/contenteditable has focus, so a shortcut
 * key does not steal a
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
          <ToolIcon name={t.tool} />
          <span className="sheet-toolbar-label">{t.label}</span>
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
        <ToolIcon name="zoom-out" />
      </button>
      <button
        type="button"
        data-testid="zoom-fit"
        title="Zoom to fit"
        className="sheet-toolbar-btn"
        onClick={() => canvas?.zoomToFit()}
      >
        <ToolIcon name="fit" />
      </button>
      <button
        type="button"
        data-testid="zoom-in"
        title="Zoom in"
        className="sheet-toolbar-btn"
        onClick={() => canvas?.zoomBy(1.2)}
      >
        <ToolIcon name="zoom-in" />
      </button>
      <span className="sheet-toolbar-sep" aria-hidden="true" />
      <button
        type="button"
        data-testid="undo"
        title="Undo (Ctrl/Cmd+Z)"
        className="sheet-toolbar-btn"
        onClick={() => canvas?.undo()}
      >
        <ToolIcon name="undo" />
      </button>
      <button
        type="button"
        data-testid="redo"
        title="Redo (Ctrl/Cmd+Shift+Z)"
        className="sheet-toolbar-btn"
        onClick={() => canvas?.redo()}
      >
        <ToolIcon name="redo" />
      </button>
    </div>
  );
}
