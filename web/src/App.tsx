import type { ReactNode } from 'react';
import { BrowserRouter, Link, Navigate, Route, Routes } from 'react-router';
import { authClient, useSession } from './lib/auth.ts';
import { Board } from './pages/Board.tsx';
import { Group } from './pages/Group.tsx';
import { Groups } from './pages/Groups.tsx';
import { Join } from './pages/Join.tsx';
import { SignIn } from './pages/SignIn.tsx';
import { Sheet } from './sheet/Sheet.tsx';

function RequireAuth({ children }: { children: ReactNode }) {
  const { data: session, isPending } = useSession();
  if (isPending) return <div className="page">loading…</div>;
  if (!session) return <Navigate to="/" replace />;
  return <>{children}</>;
}

function Nav() {
  const { data: session } = useSession();
  if (!session) return null;
  return (
    <nav className="nav">
      <Link to="/groups">groups</Link>
      <div className="spacer" />
      <span className="muted">{session.user.email}</span>
      <button type="button" onClick={() => void authClient.signOut()}>
        sign out
      </button>
    </nav>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <Nav />
      <Routes>
        <Route path="/" element={<SignIn />} />
        {/* Public — the invitation link itself must work signed out
            (docs/phases/3-groups.md section 1). */}
        <Route path="/join/:id" element={<Join />} />
        <Route
          path="/groups"
          element={
            <RequireAuth>
              <Groups />
            </RequireAuth>
          }
        />
        <Route
          path="/g/:id"
          element={
            <RequireAuth>
              <Group />
            </RequireAuth>
          }
        />
        <Route
          path="/b/:id"
          element={
            <RequireAuth>
              <Board />
            </RequireAuth>
          }
        />
        <Route
          path="/s/:id"
          element={
            <RequireAuth>
              <Sheet />
            </RequireAuth>
          }
        />
      </Routes>
    </BrowserRouter>
  );
}
