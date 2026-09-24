// Our four tools plus zoom, undo and redo. Every action goes through the
// canvas handle; region/edge drawing is handled by DrawLayer.tsx. Keys and
// their help come from shortcuts.ts. Above the toolbar, the mode bar says
// what a tool that takes the pointer is waiting for, and how to leave it.
import { useEffect } from 'react';
import { Icon, type IconName } from '../components/Icon.tsx';
import { modalOpen } from '../lib/modal.ts';
import { ShortcutsPanel } from './ShortcutsPanel.tsx';
import type { CanvasHandle } from './canvas/types.ts';
import type { Tool } from './canvas/types.ts';
import { TOOLS } from './shortcuts.ts';

interface Props {
  tool: Tool;
  onChange: (tool: Tool) => void;
  pendingEdge: boolean;
  canvas: CanvasHandle | null;
  /** The keyboard panel: open from `?`, the toolbar, or the sheet menu. */
  help: boolean;
  onHelp: (open: boolean) => void;
}

const TOOL_ICONS: Record<Tool, IconName> = {
  select: 'cursor',
  region: 'region',
  edge: 'edge',
  pan: 'hand',
};

/** What a tool is waiting for, said where the person is looking. Select
 * waits for nothing, so it has no bar. */
function modeText(tool: Tool, pendingEdge: boolean): string | null {
  switch (tool) {
    case 'region':
      return 'Drag across a picture to mark a region. Tab goes to the next picture.';
    case 'edge':
      return pendingEdge
        ? 'Now click where the connection ends.'
        : 'Click the picture or region where the connection starts.';
    case 'pan':
      return 'Drag to move around the sheet.';
    default:
      return null;
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

export function Toolbar({
  tool,
  onChange,
  pendingEdge,
  canvas,
  help,
  onHelp,
}: Props) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (typing() || e.metaKey || e.ctrlKey || e.altKey) return;
      // The keyboard panel, like every modal dialog, answers its own keys.
      if (help || modalOpen()) return;
      // The first Esc cancels a connection half made (DrawLayer.tsx); the
      // next leaves the tool, as the mode bar says.
      if (e.key === 'Escape' && !pendingEdge && tool !== 'select') {
        onChange('select');
        return;
      }
      if (e.key === '?') {
        e.preventDefault();
        onHelp(!help);
        return;
      }
      if (e.key === '0') return canvas?.zoomToFit();
      if (e.key === '+' || e.key === '=') return canvas?.zoomBy(1.2);
      if (e.key === '-') return canvas?.zoomBy(1 / 1.2);
      const match = TOOLS.find((t) => t.key === e.key.toLowerCase());
      if (match) onChange(match.tool);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onChange, canvas, pendingEdge, tool, help, onHelp]);

  const mode = modeText(tool, pendingEdge);
  return (
    // Bottom-centre, not the scene's default top-left corner: at scroll 0
    // the seed grid's row 0 sits under (0,0) and a top-left toolbar
    // overlaps it (docs/phases/2-sheet.md's prior step found this).
    <>
      {mode && (
        <div className="sheet-mode-bar" data-testid="mode-bar">
          {/* An <output> is a polite live region: the new instruction is
              read out when the tool changes, the Cancel button is not. */}
          <output data-testid={pendingEdge ? 'edge-pending' : undefined}>
            {mode}
          </output>
          <button
            type="button"
            data-testid="mode-cancel"
            onClick={() => onChange('select')}
          >
            Cancel <kbd>Esc</kbd>
          </button>
        </div>
      )}
      {help && <ShortcutsPanel onClose={() => onHelp(false)} />}
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
            <Icon
              name={TOOL_ICONS[t.tool]}
              size={15}
              className="sheet-toolbar-icon"
            />
            <span className="sheet-toolbar-label">{t.label}</span>
          </button>
        ))}
        <span className="sheet-toolbar-sep" aria-hidden="true" />
        <button
          type="button"
          data-testid="zoom-out"
          title="Zoom out"
          className="sheet-toolbar-btn"
          onClick={() => canvas?.zoomBy(1 / 1.2)}
        >
          <Icon name="zoomOut" size={15} className="sheet-toolbar-icon" />
        </button>
        <button
          type="button"
          data-testid="zoom-fit"
          className="sheet-toolbar-btn"
          onClick={() => canvas?.zoomToFit()}
          title="Fit every picture (0)"
        >
          <Icon name="fit" size={15} className="sheet-toolbar-icon" />
        </button>
        <button
          type="button"
          data-testid="zoom-in"
          title="Zoom in"
          className="sheet-toolbar-btn"
          onClick={() => canvas?.zoomBy(1.2)}
        >
          <Icon name="zoomIn" size={15} className="sheet-toolbar-icon" />
        </button>
        <span className="sheet-toolbar-sep" aria-hidden="true" />
        <button
          type="button"
          data-testid="undo"
          title="Undo (Ctrl/Cmd+Z)"
          className="sheet-toolbar-btn"
          onClick={() => canvas?.undo()}
        >
          <Icon name="undo" size={15} className="sheet-toolbar-icon" />
        </button>
        <button
          type="button"
          data-testid="redo"
          title="Redo (Ctrl/Cmd+Shift+Z)"
          className="sheet-toolbar-btn"
          onClick={() => canvas?.redo()}
        >
          <Icon name="redo" size={15} className="sheet-toolbar-icon" />
        </button>
        <span className="sheet-toolbar-sep" aria-hidden="true" />
        <button
          type="button"
          data-testid="shortcuts"
          title="Keyboard shortcuts (?)"
          aria-label="Keyboard shortcuts"
          className="sheet-toolbar-btn"
          onClick={() => onHelp(true)}
        >
          <Icon name="keyboard" size={15} className="sheet-toolbar-icon" />
        </button>
      </div>
    </>
  );
}
