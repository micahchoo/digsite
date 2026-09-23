// docs/ux/design.md §3: the persistent frame every authenticated route
// renders inside (principle 3, "the shell never disappears"). One Shell
// instance for the whole authenticated route tree (App.tsx nests /groups,
// /g/:id, /b/:id, /s/:id under it as a layout route) — a route change
// swaps only the <Outlet/> content, so the rail and channel column are
// never unmounted by navigating between groups/boards/sheets.
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { Outlet } from 'react-router';
import { authClient, useSession } from '../lib/auth.ts';
import { ChannelColumn } from './ChannelColumn.tsx';
import { GroupRail } from './GroupRail.tsx';
import { QuickSwitcher } from './QuickSwitcher.tsx';
import { RightColumnSetter } from './RightColumn.tsx';
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

// Slice 2 follow-up (c): after "sign out", a reload must show the sign-in
// page every time. `authClient.signOut()` alone raced — the session
// nanostore could still read "signed in" for a tick after the cookie
// cleared (smoke-groups.ts's own header comment on the flake it worked
// around by clearing the cookie directly instead of using this button).
// Awaiting the request, THEN hard-navigating with `window.location.href`
// (never `navigate()`) throws away every in-memory store — better-auth's
// session cache included — so there is nothing stale left to race a
// reload against.
async function signOut() {
  await authClient.signOut();
  window.location.href = '/';
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
        // Slice 2 follow-up (d): capture phase + stopPropagation, so this
        // fires and consumes the event BEFORE it can reach Excalidraw's own
        // bubble-phase keydown binding on the sheet canvas (its own
        // Ctrl/Cmd+K opens a "create link" dialog) — the seam
        // (sheet-canvas-seam.md) stays untouched; the shell wins the race
        // by going first, globally, on every page.
        e.stopPropagation();
        setSwitcherOpen(true);
        return;
      }
      if (e.key === 'Escape') {
        setDrawerOpen(false);
        setRightOpen(false);
      }
    }
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  const closeSwitcher = useCallback(() => setSwitcherOpen(false), []);

  // docs/ux/design.md §3.4: the right column exists on a board or sheet
  // page. Slice 2 turns it on for BOARDS — Board.tsx now feeds it the
  // detail panel, Explore and the sheet list through `useRightColumn`
  // (RightColumn.tsx), replacing its old inline `.board-side` column.
  // Sheet.tsx still carries its own inline panel (the Inspector) — moving
  // that in is slice 3's job, tracked there, not here.
  const [rightContent, setRightContent] = useState<ReactNode>(null);
  const hasRightColumn = route.kind === 'board';

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
            onClick={() => void signOut()}
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
          <RightColumnSetter value={setRightContent}>
            <Outlet context={route} />
          </RightColumnSetter>
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
            <div className="muted shell-right-empty">Nobody else yet.</div>
            {rightContent}
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
