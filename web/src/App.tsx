import type { ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { useSession } from './lib/auth.ts';
import { Board } from './pages/Board.tsx';
import { Group } from './pages/Group.tsx';
import { Groups } from './pages/Groups.tsx';
import { Join } from './pages/Join.tsx';
import { SignIn } from './pages/SignIn.tsx';
import { Sheet } from './sheet/Sheet.tsx';
import { Shell } from './shell/Shell.tsx';

function RequireAuth({ children }: { children: ReactNode }) {
  const { data: session, isPending } = useSession();
  if (isPending) return <div className="page">loading…</div>;
  if (!session) return <Navigate to="/" replace />;
  return <>{children}</>;
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<SignIn />} />
        {/* Public — the invitation link itself must work signed out
            (docs/phases/3-groups.md section 1). */}
        <Route path="/join/:id" element={<Join />} />
        {/* docs/ux/design.md §3: every signed-in route renders inside the
            persistent shell (rail, channel column, top bar) — a layout
            route, so navigating between groups/boards/sheets swaps only
            this subtree's <Outlet/>, never Shell itself. Sign-in and join
            stay outside it (full-page, per the design doc). */}
        <Route
          element={
            <RequireAuth>
              <Shell />
            </RequireAuth>
          }
        >
          <Route path="/groups" element={<Groups />} />
          <Route path="/g/:id" element={<Group />} />
          <Route path="/b/:id" element={<Board />} />
          <Route path="/s/:id" element={<Sheet />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
