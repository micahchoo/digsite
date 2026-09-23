// docs/ux/design.md §3.1: the current group's boards as `#channels`, each
// board's sheets nested beneath it as threads (docs/phases/6-product.md
// "Sheets are threads"). Collapse state is per board, remembered in
// localStorage so it survives a reload/navigation — the column itself
// never unmounts across a route change (it lives inside Shell, not inside
// a page), so this is a belt-and-braces persistence, not the only thing
// keeping a board's fold state alive during one session.
import { useState } from 'react';
import { Link } from 'react-router';
import { Icon } from '../components/Icon.tsx';
import type {
  BoardSummaryWithStats,
  SheetSummaryWithStats,
  api,
} from '../lib/api.ts';

interface Props {
  groupName: string | null;
  groupId: string | null;
  boards: BoardSummaryWithStats[];
  sheetsByBoard: Record<string, SheetSummaryWithStats[]>;
  activeBoardId: string | null;
  activeSheetId: string | null;
}

function collapseKey(boardId: string): string {
  return `digsite:shell:collapsed:${boardId}`;
}

function readCollapsed(boardId: string): boolean {
  try {
    return localStorage.getItem(collapseKey(boardId)) === '1';
  } catch {
    return false;
  }
}

function writeCollapsed(boardId: string, collapsed: boolean): void {
  try {
    if (collapsed) localStorage.setItem(collapseKey(boardId), '1');
    else localStorage.removeItem(collapseKey(boardId));
  } catch {
    // localStorage unavailable (private mode, quota) — the fold still
    // works for this session via component state.
  }
}

function BoardRow({
  board,
  sheets,
  activeBoardId,
  activeSheetId,
}: {
  board: BoardSummaryWithStats;
  sheets: SheetSummaryWithStats[];
  activeBoardId: string | null;
  activeSheetId: string | null;
}) {
  const [collapsed, setCollapsed] = useState(() => readCollapsed(board.id));

  function toggle() {
    setCollapsed((prev) => {
      const next = !prev;
      writeCollapsed(board.id, next);
      return next;
    });
  }

  return (
    <li className="shell-board" data-testid="shell-board">
      <div className="shell-board-row">
        <button
          type="button"
          className="shell-board-toggle"
          onClick={toggle}
          aria-expanded={!collapsed}
          aria-label={
            collapsed ? `Expand ${board.name}` : `Collapse ${board.name}`
          }
          data-testid={`shell-board-toggle-${board.id}`}
        >
          <Icon name="chevronRight" size={13} />
        </button>
        <Link
          to={`/b/${board.id}`}
          className={
            board.id === activeBoardId
              ? 'shell-board-link shell-board-link--active'
              : 'shell-board-link'
          }
          data-testid="shell-board-link"
        >
          {!board.open && <Icon name="lock" size={13} className="shell-lock" />}
          <Icon name="hash" size={14} className="shell-board-hash" />
          <span className="shell-board-name">{board.name}</span>
        </Link>
      </div>
      {!collapsed && (
        <ul className="shell-sheet-list" data-testid="shell-sheet-list">
          {sheets.map((s) => (
            <li key={s.id}>
              <Link
                to={`/s/${s.id}`}
                className={
                  s.id === activeSheetId
                    ? 'shell-sheet-link shell-sheet-link--active'
                    : 'shell-sheet-link'
                }
                data-testid="shell-sheet-link"
                data-unread={Boolean(s.unread && s.id !== activeSheetId)}
              >
                <Icon name="thread" size={14} className="shell-thread-glyph" />
                {s.name}
                {s.unread && s.id !== activeSheetId && (
                  <span
                    className="shell-unread-dot"
                    role="img"
                    aria-label="Unread activity"
                  />
                )}
              </Link>
            </li>
          ))}
          <li>
            <Link
              to={`/b/${board.id}`}
              className="shell-start-sheet"
              data-testid={`shell-start-sheet-${board.id}`}
            >
              <Icon name="plus" size={14} />
              Start a sheet
            </Link>
          </li>
        </ul>
      )}
    </li>
  );
}

export function ChannelColumn({
  groupName,
  groupId,
  boards,
  sheetsByBoard,
  activeBoardId,
  activeSheetId,
}: Props) {
  if (!groupId) {
    return (
      <div className="shell-channel" data-testid="shell-channel">
        <div className="shell-channel-empty muted">Pick a group.</div>
      </div>
    );
  }

  return (
    <div className="shell-channel" data-testid="shell-channel">
      <div className="shell-channel-header">
        <div className="shell-channel-identity">
          <span className="shell-channel-title">{groupName ?? ''}</span>
        </div>
        <Link
          to={`/g/${groupId}`}
          className="shell-channel-gear"
          title="Group settings"
          aria-label="Group settings"
          data-testid="shell-group-settings"
        >
          <Icon name="settings" />
        </Link>
      </div>
      <ul className="shell-board-list">
        {boards.map((b) => (
          <BoardRow
            key={b.id}
            board={b}
            sheets={sheetsByBoard[b.id] ?? []}
            activeBoardId={activeBoardId}
            activeSheetId={activeSheetId}
          />
        ))}
      </ul>
    </div>
  );
}
