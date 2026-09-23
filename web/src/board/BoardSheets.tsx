// The board's sheets, in the right column: each one to rename, select on
// the map, open or delete (docs/phases/2-sheet.md section 6). The list is a
// hook of its own because the tray reads it too; it refreshes on the page's
// sheets-changed event (lib/sheetEvents.ts), so whatever changes a sheet
// only has to say so.
import type { SheetFootprint } from '@digsite/shared';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Confirm } from '../components/Confirm.tsx';
import { Icon } from '../components/Icon.tsx';
import { RenameInline } from '../components/RenameInline.tsx';
import { ApiError, api } from '../lib/api.ts';
import { plural } from '../lib/plural.ts';
import { notifySheetsChanged, onSheetsChanged } from '../lib/sheetEvents.ts';
import { ThreadBrowser } from './ThreadBrowser.tsx';
import { sheetDeleteMessage } from './messages.ts';

export type BoardSheet = Awaited<ReturnType<typeof api.listSheets>>[number];

export function useBoardSheets(boardId: string): BoardSheet[] {
  const [sheets, setSheets] = useState<BoardSheet[]>([]);
  const refresh = useCallback(async () => {
    setSheets(await api.listSheets(boardId).catch(() => []));
  }, [boardId]);
  useEffect(() => {
    void refresh();
    return onSheetsChanged(() => void refresh());
  }, [refresh]);
  return sheets;
}

/** Today a sheet's save reads as a time; before today, as a date. */
function savedLabel(iso: string): string {
  const at = new Date(iso);
  const today = new Date().toDateString() === at.toDateString();
  return today
    ? `Saved ${at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
    : `Saved ${at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

export function BoardSheets({
  boardId,
  groupId,
  sheets,
  onSelect,
}: {
  boardId: string;
  groupId: string;
  sheets: BoardSheet[];
  /** Select a sheet's images on the map. */
  onSelect: (sheetId: string) => void;
}) {
  // A delete shows its footprint first (docs/phases/3-groups.md section 4:
  // "how many other sheets' foreign views it affects").
  const [confirm, setConfirm] = useState<{
    sheetId: string;
    footprint: SheetFootprint;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function askDelete(sheetId: string) {
    setError(null);
    try {
      setConfirm({ sheetId, footprint: await api.getSheetFootprint(sheetId) });
    } catch (err) {
      setError(err instanceof ApiError ? err.reason : String(err));
    }
  }
  async function confirmDelete() {
    if (!confirm) return;
    setBusy(true);
    try {
      await api.deleteSheet(confirm.sheetId);
      setConfirm(null);
      notifySheetsChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.reason : String(err));
    } finally {
      setBusy(false);
    }
  }
  async function rename(sheetId: string, name: string) {
    await api.updateSheet(sheetId, { name });
    notifySheetsChanged();
  }

  return (
    <section className="board-panel-section">
      <header className="board-panel-heading">
        <h2>
          Sheets <span className="board-panel-count">{sheets.length}</span>
        </h2>
        <ThreadBrowser
          groupId={groupId}
          boardId={boardId}
          onChanged={async () => notifySheetsChanged()}
        />
      </header>
      {error && !confirm && <div className="error">{error}</div>}
      {sheets.length === 0 ? (
        <p className="board-empty-note">
          Select images on the map, then start a sheet to arrange them together.
        </p>
      ) : (
        <ul data-testid="sheet-list" className="board-sheet-list">
          {sheets.map((sheet) => (
            <li
              key={sheet.id}
              data-testid="sheet-list-item"
              className="board-sheet-row"
            >
              <div className="board-sheet-copy">
                <RenameInline
                  name={sheet.name}
                  onRename={(name) => rename(sheet.id, name)}
                  testId={`sheet-rename-${sheet.id}`}
                />
                <span className="board-sheet-meta">
                  {plural(sheet.imageCount, 'image')} ·{' '}
                  {sheet.savedAt ? savedLabel(sheet.savedAt) : 'Not saved'}
                </span>
              </div>
              <div className="board-sheet-actions">
                <button
                  type="button"
                  className="board-quiet-button"
                  data-testid={`sheet-select-${sheet.id}`}
                  title="Select this sheet's images on the map"
                  onClick={() => onSelect(sheet.id)}
                >
                  Select
                </button>
                <Link className="board-sheet-open" to={`/s/${sheet.id}`}>
                  Open
                </Link>
                <button
                  type="button"
                  className="board-icon-button board-icon-button--danger"
                  data-testid={`sheet-delete-${sheet.id}`}
                  aria-label={`Delete sheet ${sheet.name}`}
                  title="Delete sheet"
                  onClick={() => void askDelete(sheet.id)}
                >
                  <Icon name="trash" size={16} />
                </button>
              </div>
              {confirm?.sheetId === sheet.id && (
                <Confirm
                  testId={`sheet-delete-confirm-${sheet.id}`}
                  message={sheetDeleteMessage(sheet.name, confirm.footprint)}
                  busy={busy}
                  error={error}
                  onConfirm={() => void confirmDelete()}
                  onCancel={() => setConfirm(null)}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
