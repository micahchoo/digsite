// docs/ux/design.md §3.1: the left rail — round group icons, the active
// group gets a pill and a filled ring, a `+` opens `/groups` (create or
// join — that flow already lives on Groups.tsx, no new modal needed for
// slice 1). Unread-group dots are skipped: no endpoint returns group-level
// unread yet, and the task's own instruction is to render only what the
// API already returns.
import { Link } from 'react-router';
import type { api } from '../lib/api.ts';

interface Props {
  groups: Awaited<ReturnType<typeof api.listGroups>>;
  activeGroupId: string | null;
}

function initialsOf(name: string): string {
  const trimmed = name.trim();
  return trimmed ? (trimmed[0]?.toUpperCase() ?? '?') : '?';
}

export function GroupRail({ groups, activeGroupId }: Props) {
  return (
    <nav className="shell-rail" aria-label="Groups" data-testid="shell-rail">
      <Link
        to="/groups"
        className="shell-rail-brand"
        aria-label="Digsite workspaces"
        title="Digsite workspaces"
      >
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
          <rect x="3.5" y="3.5" width="7" height="7" rx="2" />
          <rect x="13.5" y="3.5" width="7" height="7" rx="2" />
          <rect x="3.5" y="13.5" width="7" height="7" rx="2" />
          <path d="M13.5 17h7M17 13.5v7" />
        </svg>
      </Link>
      <ul className="shell-rail-list">
        {groups.map((g) => (
          <li key={g.id} className="shell-rail-item">
            <Link
              to={`/g/${g.id}`}
              className={
                g.id === activeGroupId
                  ? 'shell-rail-icon shell-rail-icon--active'
                  : 'shell-rail-icon'
              }
              data-testid="shell-rail-group"
              data-group-id={g.id}
              aria-current={g.id === activeGroupId ? 'true' : undefined}
              title={g.name}
            >
              {initialsOf(g.name)}
            </Link>
          </li>
        ))}
      </ul>
      <Link
        to="/groups"
        className="shell-rail-icon shell-rail-add"
        data-testid="shell-rail-add"
        title="Create or join a group"
        aria-label="Create or join a group"
      >
        <svg
          aria-hidden="true"
          className="shell-icon"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        >
          <path d="M10 4v12M4 10h12" />
        </svg>
      </Link>
    </nav>
  );
}
