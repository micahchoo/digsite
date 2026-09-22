// docs/ux/design.md §3: the persistent frame every authenticated route
// renders inside (principle 3, "the shell never disappears"). One Shell
// instance for the whole authenticated route tree (App.tsx nests /groups,
// /g/:id, /b/:id, /s/:id under it as a layout route) — a route change
// swaps only the <Outlet/> content, so the rail and channel column are
// never unmounted by navigating between groups/boards/sheets.
import { useCallback, useEffect, useState } from 'react';
import { Outlet } from 'react-router';
import { authClient, useSession } from '../lib/auth.ts';
import { ChannelColumn } from './ChannelColumn.tsx';
import { GroupRail } from './GroupRail.tsx';
import { QuickSwitcher } from './QuickSwitcher.tsx';
import './shell.css';
import { TopBar } from './TopBar.tsx';
import { useShellData } from './useShellData.ts';

// A debug hook, same convention as window.__digsiteBoard/window.__digsite
// (sheet/tools.ts): `mounts` only increments in an effect with an empty
// dependency array, so smoke-shell.ts can assert it stays 1 across a
// group switch — proof the rail/channel column were never torn down and
// rebuilt, not just visually stable.
declare global {
  interface Window {
    __digsiteShell?: { mounts: number };
  }
}

export function Shell() {
  const { data: session } = useSession();
  const { route, groups, boards, sheetsByBoard } = useShellData();

  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);

  useEffect(() => {
    window.__digsiteShell = window.__digsiteShell ?? { mounts: 0 };
    window.__digsiteShell.mounts += 1;
  }, []);

  // Close the mobile drawer / tablet right panel whenever the route
  // changes — otherwise a link tapped inside the drawer would leave it
  // open over the new page. The effect body never reads `route`; the
  // dependency array is what's meant to trigger the reset.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset is triggered BY a route change, not by reading it
  useEffect(() => {
    setDrawerOpen(false);
    setRightOpen(false);
  }, [route.kind, route.groupId, route.boardId, route.sheetId]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSwitcherOpen(true);
        return;
      }
      if (e.key === 'Escape') {
        setDrawerOpen(false);
        setRightOpen(false);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const closeSwitcher = useCallback(() => setSwitcherOpen(false), []);

  // docs/ux/design.md §3.4: the right column exists only on a board or
  // sheet page. NOT rendered yet, even there: Board.tsx and Sheet.tsx
  // already carry their own inline right-side panel (selection/allowlist,
  // the sheet Inspector) at their existing fixed width, predating the
  // shell. Stacking an empty shell-owned column next to that live one
  // double-counted the width on every board/sheet page — it doesn't just
  // look wrong, it shrinks deck.gl's canvas and Excalidraw's stage enough
  // to move where a click/hover/drag lands, which broke every
  // coordinate-sensitive existing smoke (selection rank, region drag,
  // foreign-shape hit test). Moving that inline content INTO this column
  // is slice 2/3's job (design.md §7); until then the frame stays built
  // (below) but unused, so nothing here needs revisiting once that lands.
  const hasRightColumn = false;

  return (
    <div
      className={
        drawerOpen ? 'shell-root shell-root--drawer-open' : 'shell-root'
      }
      data-testid="shell-root"
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: a click-away scrim; Escape already closes it via the global keydown handler above */}
      <div
        className="shell-drawer-scrim"
        data-testid="shell-drawer-scrim"
        onClick={() => setDrawerOpen(false)}
      />
      <GroupRail groups={groups} activeGroupId={route.groupId} />
      <div className="shell-channel-wrap">
        <ChannelColumn
          groupName={route.groupName}
          groupId={route.groupId}
          boards={boards}
          sheetsByBoard={sheetsByBoard}
          activeBoardId={route.boardId}
          activeSheetId={route.sheetId}
        />
        <div className="shell-channel-footer" data-testid="shell-user-footer">
          <span className="muted shell-user-email">
            {session?.user.email ?? ''}
          </span>
          <button
            type="button"
            onClick={() => void authClient.signOut()}
            data-testid="shell-sign-out"
          >
            sign out
          </button>
        </div>
      </div>
      <div className="shell-main">
        <TopBar
          route={route}
          onOpenSwitcher={() => setSwitcherOpen(true)}
          onToggleDrawer={() => setDrawerOpen((v) => !v)}
          onToggleRight={() => setRightOpen((v) => !v)}
          hasRightColumn={hasRightColumn}
        />
        <div className="shell-page" data-testid="shell-page">
          <Outlet />
        </div>
      </div>
      {hasRightColumn && (
        <>
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: a click-away scrim; Escape already closes it via the global keydown handler above */}
          <div
            className={
              rightOpen
                ? 'shell-right-scrim shell-right-scrim--open'
                : 'shell-right-scrim'
            }
            data-testid="shell-right-scrim"
            onClick={() => setRightOpen(false)}
          />
          <aside
            className={
              rightOpen ? 'shell-right shell-right--open' : 'shell-right'
            }
            data-testid="shell-right"
          >
            <div className="shell-right-header">
              <span>Who's here</span>
              <button
                type="button"
                className="shell-right-close"
                aria-label="Close panel"
                data-testid="shell-right-close"
                onClick={() => setRightOpen(false)}
              >
                ×
              </button>
            </div>
            <div className="muted shell-right-empty">Nothing here yet.</div>
          </aside>
        </>
      )}
      <QuickSwitcher
        open={switcherOpen}
        onClose={closeSwitcher}
        groups={groups}
        boards={boards}
        sheetsByBoard={sheetsByBoard}
      />
    </div>
  );
}
