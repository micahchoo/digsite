import type { BoardImage } from '@digsite/shared';
import { SHEET_LIMIT } from '@digsite/shared';
// docs/ux/design.md §4.5 "Selection tray" / §5.1 "The tray". Bottom of the
// board, collapses to a 40px pill when the selection is empty ("an empty
// tray is simply not there" — better-writing's "never park persistent
// information in an empty state"). Thumbnails in SELECTION order (drag to
// reorder — that order becomes a new sheet's initial grid layout, design.md
// §5.1's own "What a selection can become"); hover flashes the image's cell
// on the map; click flies there; `×` removes just that one.
import { useEffect, useRef, useState } from 'react';
import { type SheetSummaryWithStats, api } from '../lib/api.ts';
import { plural } from '../lib/plural.ts';
import type { SaveState } from './useSelection.ts';

export interface TrayAction {
  overCap: boolean;
  cappedCount: number;
}

interface Props {
  items: BoardImage[]; // in selection order
  sheets: SheetSummaryWithStats[];
  onRemove: (id: string) => void;
  onReorder: (nextIds: string[]) => void;
  onHoverItem: (id: string | null) => void;
  onClickItem: (id: string) => void;
  onClear: () => void;
  onInvert: () => void;
  onStartSheet: (name: string) => Promise<void> | void;
  onAddToSheet: (sheetId: string) => Promise<void> | void;
  startRequested?: boolean;
  onStartRequested?: () => void;
  addRequested?: boolean;
  onAddRequested?: () => void;
  saveState?: SaveState;
}

export function Tray({
  items,
  sheets,
  onRemove,
  onReorder,
  onHoverItem,
  onClickItem,
  onClear,
  onInvert,
  onStartSheet,
  onAddToSheet,
  startRequested = false,
  onStartRequested,
  addRequested = false,
  onAddRequested,
  saveState = 'idle',
}: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [naming, setNaming] = useState(false);
  const [sheetName, setSheetName] = useState('');
  const [addPickerOpen, setAddPickerOpen] = useState(false);
  const dragIndex = useRef<number | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);

  // RenameInline.tsx's own pattern (a ref + effect, not the `autoFocus`
  // attribute biome's a11y rule refuses): focus the name field the moment
  // "Start a sheet" reveals it.
  useEffect(() => {
    if (naming) nameInputRef.current?.focus();
  }, [naming]);
  useEffect(() => {
    if (!startRequested) return;
    setNaming(true);
    onStartRequested?.();
  }, [startRequested, onStartRequested]);
  useEffect(() => {
    if (!addRequested) return;
    setAddPickerOpen(true);
    onAddRequested?.();
  }, [addRequested, onAddRequested]);

  if (items.length === 0) {
    return (
      <div className="board-tray board-tray--empty" data-testid="board-tray">
        {saveState !== 'idle' && (
          <span
            className="muted board-tray-save-state"
            data-testid="board-selection-save-state"
            aria-live="polite"
          >
            {saveState === 'saving'
              ? 'Saving selection…'
              : saveState === 'saved'
                ? 'Selection saved'
                : 'Selection not saved'}
          </span>
        )}
      </div>
    );
  }

  const over = items.length > SHEET_LIMIT;
  const startCount = Math.min(items.length, SHEET_LIMIT);

  function move(from: number, to: number) {
    if (from === to) return;
    const next = [...items.map((i) => i.id)];
    const [moved] = next.splice(from, 1);
    if (moved === undefined) return;
    next.splice(to, 0, moved);
    onReorder(next);
  }

  async function submitStartSheet(e: React.FormEvent) {
    e.preventDefault();
    const name = sheetName.trim();
    if (!name) return;
    await onStartSheet(name);
    setSheetName('');
    setNaming(false);
  }

  return (
    <div className="board-tray" data-testid="board-tray">
      <div className="board-tray-header">
        <button
          type="button"
          className="board-tray-collapse"
          aria-label={collapsed ? 'Expand selection' : 'Collapse selection'}
          data-testid="board-tray-collapse"
          onClick={() => setCollapsed((v) => !v)}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        <span data-testid="board-tray-count">
          {over
            ? `${items.length} selected (${startCount} / ${SHEET_LIMIT})`
            : `${items.length} selected`}
        </span>
        <span
          className="muted board-tray-save-state"
          data-testid="board-selection-save-state"
          aria-live="polite"
        >
          {saveState === 'saving'
            ? 'Saving…'
            : saveState === 'saved'
              ? 'Saved'
              : saveState === 'error'
                ? 'Not saved'
                : ''}
        </span>
        <span className="board-tray-spacer" />
        <button
          type="button"
          data-testid="board-tray-invert"
          onClick={onInvert}
        >
          Invert
        </button>
        <button
          type="button"
          data-testid="board-tray-clear"
          aria-label="Clear selection"
          onClick={onClear}
        >
          ×
        </button>
      </div>

      {!collapsed && (
        <>
          <div className="board-tray-strip" data-testid="board-tray-strip">
            {items.map((img, i) => (
              <div
                key={img.id}
                className="board-tray-thumb"
                // "selection-item": the same testid the board's old inline
                // selection list used (smoke-board.ts/smoke-explore.ts/
                // smoke-groups.ts all click it to open an image's detail —
                // Board.tsx now auto-focuses the sole selected image, but a
                // click here still sets FOCUS even with several selected).
                data-testid="selection-item"
                data-missing={img.missing}
                // biome-ignore lint/a11y/useSemanticElements: hosts a real nested <button> (remove) — a <button> cannot contain one
                role="button"
                tabIndex={0}
                draggable
                onDragStart={() => {
                  dragIndex.current = i;
                }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  const from = dragIndex.current;
                  dragIndex.current = null;
                  if (from !== null) move(from, i);
                }}
                onMouseEnter={() => onHoverItem(img.id)}
                onMouseLeave={() => onHoverItem(null)}
                onClick={() => onClickItem(img.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onClickItem(img.id);
                  }
                }}
                title={img.name}
              >
                {img.missing ? (
                  <span className="board-tray-thumb-missing">(missing)</span>
                ) : (
                  <img src={api.originalUrl(img.id)} alt="" />
                )}
                <button
                  type="button"
                  className="board-tray-thumb-remove"
                  aria-label={`Remove ${img.name}`}
                  data-testid="board-tray-thumb-remove"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemove(img.id);
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>

          <div className="board-tray-actions">
            {naming ? (
              <form className="row" onSubmit={(e) => void submitStartSheet(e)}>
                <input
                  ref={nameInputRef}
                  data-testid="board-tray-sheet-name"
                  placeholder="Sheet name"
                  value={sheetName}
                  onChange={(e) => setSheetName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setNaming(false);
                  }}
                />
                <button
                  type="submit"
                  data-testid="board-tray-sheet-create"
                  disabled={!sheetName.trim()}
                >
                  Create
                </button>
                <button type="button" onClick={() => setNaming(false)}>
                  Cancel
                </button>
              </form>
            ) : (
              <button
                type="button"
                data-testid="board-tray-start-sheet"
                onClick={() => setNaming(true)}
              >
                {over
                  ? `Start a sheet with the first ${startCount} of ${items.length}`
                  : 'Start a sheet'}
              </button>
            )}
            <div className="board-tray-add-wrap">
              <button
                type="button"
                data-testid="board-tray-add-to-sheet"
                onClick={() => setAddPickerOpen((v) => !v)}
              >
                Add to sheet…
              </button>
              {addPickerOpen && (
                <div
                  className="board-tray-add-picker"
                  data-testid="board-tray-add-picker"
                >
                  {sheets.length === 0 && (
                    <div className="muted" style={{ padding: 6 }}>
                      No sheets on this board yet.
                    </div>
                  )}
                  {sheets.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      className="board-tray-add-picker-item"
                      data-testid={`board-tray-add-to-sheet-${s.id}`}
                      onClick={() => {
                        setAddPickerOpen(false);
                        void onAddToSheet(s.id);
                      }}
                    >
                      {s.name}{' '}
                      <span className="muted">
                        ({plural(s.imageCount, 'image')})
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button
              type="button"
              disabled
              data-testid="board-tray-copy"
              aria-disabled="true"
              title="Copying images to another board is not available yet."
            >
              Copy to another board…
            </button>
            <button
              type="button"
              disabled
              data-testid="board-tray-download"
              aria-disabled="true"
              title="Downloading selected originals is not available yet."
            >
              Download
            </button>
          </div>
        </>
      )}
    </div>
  );
}
