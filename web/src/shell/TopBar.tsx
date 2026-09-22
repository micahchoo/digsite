// docs/ux/design.md §3.1: breadcrumb leading, search (opens the quick
// switcher — slice 1's own scope for "search"; board find/filter is slice
// 2) and a `⋯` actions slot trailing. The hamburger (<768px) and the right
// column toggle (768–1279px) live here too (§3.2, §3.3) — both are plain
// CSS-hidden outside their breakpoint, not conditionally rendered, so
// there's nothing for a resize to remount.
import { Link } from 'react-router';
import type { ShellRoute } from './useShellData.ts';

interface Props {
  route: ShellRoute;
  onOpenSwitcher: () => void;
  onToggleDrawer: () => void;
  onToggleRight: () => void;
  hasRightColumn: boolean;
}

function Breadcrumb({ route }: { route: ShellRoute }) {
  if (route.kind === 'groups') {
    return (
      <span
        className="shell-crumb-current"
        data-testid="shell-breadcrumb-current"
      >
        Groups
      </span>
    );
  }
  if (route.kind === 'group') {
    return (
      <span
        className="shell-crumb-current"
        data-testid="shell-breadcrumb-current"
      >
        {route.groupName ?? '…'}
      </span>
    );
  }
  if (route.kind === 'board') {
    return (
      <span
        className="shell-crumb-current"
        data-testid="shell-breadcrumb-current"
      >
        <span aria-hidden="true">#</span> {route.boardName ?? '…'}
      </span>
    );
  }
  if (route.kind === 'sheet') {
    return (
      <>
        {route.boardId ? (
          <Link
            to={`/b/${route.boardId}`}
            className="shell-crumb-ancestor"
            data-testid="shell-breadcrumb-ancestor"
          >
            <span aria-hidden="true">#</span> {route.boardName ?? '…'}
          </Link>
        ) : (
          <span className="shell-crumb-ancestor">{route.boardName ?? '…'}</span>
        )}
        <span className="shell-crumb-sep" aria-hidden="true">
          {' '}
          ›{' '}
        </span>
        <span
          className="shell-crumb-current"
          data-testid="shell-breadcrumb-current"
        >
          {route.sheetName ?? '…'}
        </span>
      </>
    );
  }
  return null;
}

export function TopBar({
  route,
  onOpenSwitcher,
  onToggleDrawer,
  onToggleRight,
  hasRightColumn,
}: Props) {
  return (
    <div className="shell-topbar" data-testid="shell-topbar">
      <button
        type="button"
        className="shell-hamburger"
        onClick={onToggleDrawer}
        aria-label="Open groups and boards"
        data-testid="shell-hamburger"
      >
        ☰
      </button>
      <div className="shell-breadcrumb" data-testid="shell-breadcrumb">
        <Breadcrumb route={route} />
      </div>
      <div className="shell-topbar-spacer" />
      <button
        type="button"
        className="shell-search"
        onClick={onOpenSwitcher}
        aria-label="Jump to a group, board or sheet"
        data-testid="shell-search"
      >
        🔍 <span className="shell-search-label">Jump to…</span>
      </button>
      {hasRightColumn && (
        <button
          type="button"
          className="shell-right-toggle"
          onClick={onToggleRight}
          aria-label="Toggle side panel"
          data-testid="shell-right-toggle"
        >
          ▤
        </button>
      )}
      <button
        type="button"
        className="shell-overflow"
        aria-label="Page actions"
        data-testid="shell-overflow"
      >
        ⋯
      </button>
    </div>
  );
}
