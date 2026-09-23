// docs/ux/design.md §3.1: the current group's boards as `#channels`, each
// board's sheets nested beneath it as threads (docs/phases/6-product.md
// "Sheets are threads"). Collapse state is per board, remembered in
// localStorage so it survives a reload/navigation — the column itself
// never unmounts across a route change (it lives inside Shell, not inside
// a page), so this is a belt-and-braces persistence, not the only thing
// keeping a board's fold state alive during one session.
import { useState } from 'react';
import { Link } from 'react-router';
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
          {collapsed ? '▸' : '▾'}
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
          {!board.open && (
            <span className="shell-lock" aria-hidden="true">
              🔒
            </span>
          )}
          <span aria-hidden="true">#</span> {board.name}
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
                <span className="shell-thread-glyph" aria-hidden="true">
                  ↳
                </span>
                {s.name}
                {s.unread && s.id !== activeSheetId && (
                  <span
                    className="shell-unread-dot"
                    aria-label="Unread activity"
                  >
                    •
                  </span>
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
              + Start a sheet
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
        <span className="shell-channel-title">{groupName ?? ''}</span>
        <Link
          to={`/g/${groupId}`}
          className="shell-channel-gear"
          title="Group settings"
          aria-label="Group settings"
          data-testid="shell-group-settings"
        >
          <svg
            aria-hidden="true"
            className="shell-icon"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="10" cy="10" r="3" />
            <path d="M10 2.5v2M10 15.5v2M17.5 10h-2M4.5 10h-2m12.8-5.3-1.4 1.4M6.1 13.9l-1.4 1.4m10.6 0-1.4-1.4M6.1 6.1 4.7 4.7" />
          </svg>
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
