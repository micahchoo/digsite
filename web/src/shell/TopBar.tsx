// docs/ux/design.md §3.1: breadcrumb leading, search (opens the quick
// switcher — slice 1's own scope for "search"; board find/filter is slice
// 2) and an actions slot trailing. The hamburger (<768px) and the right
// column toggle (768–1279px) live here too (§3.2, §3.3) — both are plain
// CSS-hidden outside their breakpoint, not conditionally rendered, so
// there's nothing for a resize to remount.
import { Link } from 'react-router';
import { Icon } from '../components/Icon.tsx';
import { UploadIndicator } from './UploadIndicator.tsx';
import type { ShellRoute } from './useShellData.ts';

interface Props {
  route: ShellRoute;
  onOpenSwitcher: () => void;
  onToggleDrawer: () => void;
  onToggleRight: () => void;
  hasRightColumn: boolean;
}

interface Crumb {
  label: string;
  /** Absent on the last crumb: it is the page itself. */
  to?: string;
  board?: boolean;
}

/** The path to this page, outermost first: group, board, sheet. */
function crumbsOf(route: ShellRoute): Crumb[] {
  const group: Crumb = {
    label: route.groupName ?? '…',
    to: route.groupId ? `/g/${route.groupId}` : undefined,
  };
  const board: Crumb = {
    label: route.boardName ?? '…',
    to: route.boardId ? `/b/${route.boardId}` : undefined,
    board: true,
  };
  switch (route.kind) {
    case 'groups':
      return [{ label: 'Groups' }];
    case 'group':
      return [{ label: group.label }];
    case 'board':
      return [group, { ...board, to: undefined }];
    case 'sheet':
      return [group, board, { label: route.sheetName ?? '…' }];
    default:
      return [];
  }
}

function Breadcrumb({ route }: { route: ShellRoute }) {
  const crumbs = crumbsOf(route);
  return (
    <ol className="shell-crumbs">
      {crumbs.map((crumb, i) => {
        const last = i === crumbs.length - 1;
        const label = (
          <>
            {crumb.board && <Icon name="hash" size={14} />}
            <span className="shell-crumb-label">{crumb.label}</span>
          </>
        );
        return (
          <li key={`${i}-${crumb.label}`}>
            {i > 0 && (
              <Icon
                name="chevronRight"
                size={14}
                className="shell-crumb-sep"
                data-testid="shell-breadcrumb-sep"
              />
            )}
            {last ? (
              <span
                className="shell-crumb-current"
                data-testid="shell-breadcrumb-current"
                aria-current="page"
              >
                {label}
              </span>
            ) : crumb.to ? (
              <Link
                to={crumb.to}
                className="shell-crumb-ancestor"
                data-testid="shell-breadcrumb-ancestor"
              >
                {label}
              </Link>
            ) : (
              <span className="shell-crumb-ancestor">{label}</span>
            )}
          </li>
        );
      })}
    </ol>
  );
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
        <Icon name="menu" />
      </button>
      <nav
        className="shell-breadcrumb"
        data-testid="shell-breadcrumb"
        aria-label="Breadcrumb"
      >
        <Breadcrumb route={route} />
      </nav>
      <div className="shell-topbar-spacer" />
      <UploadIndicator />
      <button
        type="button"
        className="shell-search"
        onClick={onOpenSwitcher}
        aria-label="Jump to a group, board or sheet"
        data-testid="shell-search"
      >
        <Icon name="search" />{' '}
        <span className="shell-search-label">Jump to…</span>
      </button>
      {hasRightColumn && (
        <button
          type="button"
          className="shell-right-toggle"
          onClick={onToggleRight}
          aria-label="Toggle side panel"
          data-testid="shell-right-toggle"
        >
          <Icon name="panel" />
        </button>
      )}
      <button
        type="button"
        className="shell-overflow"
        aria-label="Page actions"
        data-testid="shell-overflow"
      >
        <Icon name="more" />
      </button>
    </div>
  );
}
