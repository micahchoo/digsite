// /join/:id (docs/phases/3-groups.md section 1). Public: works signed out.
// GET /invitations/:id is the one public route in the whole app — it
// returns only the group name, the inviter's name and whether the
// invitation is still open, never anything that would let a signed-out
// visitor learn more about the group. An expired invitation and a used one
// answer with the same `open: false` — the plugin cannot tell them apart
// (../.claude/rules/access-one-function-per-intent.md), so this shows one
// message for both, never a guess at which.
import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { ApiError, api } from '../lib/api.ts';
import { authClient, useSession } from '../lib/auth.ts';

const CLOSED_MESSAGE = 'This invitation is no longer open.';

export function Join() {
  const { id } = useParams<{ id: string }>();
  const invitationId = id ?? '';
  const { data: session, isPending } = useSession();

  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'closed' }
    | { kind: 'not-found' }
    | { kind: 'open'; groupName: string; inviterName: string }
  >({ kind: 'loading' });
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api
      .getInvitation(invitationId)
      .then((inv) => {
        if (cancelled) return;
        setState(
          inv.open
            ? {
                kind: 'open',
                groupName: inv.groupName,
                inviterName: inv.inviterName,
              }
            : { kind: 'closed' },
        );
      })
      .catch((err) => {
        if (cancelled) return;
        setState(
          err instanceof ApiError && err.status === 404
            ? { kind: 'not-found' }
            : { kind: 'closed' },
        );
      });
    return () => {
      cancelled = true;
    };
  }, [invitationId]);

  async function accept() {
    setAccepting(true);
    setError(null);
    try {
      const { groupId } = await api.acceptInvitation(invitationId);
      // A hard navigation, not react-router's `navigate` — this crosses the
      // signed-out/signed-in boundary right after `signUp`/`signIn`, and
      // the client's session cache (nanostores under useSession) does not
      // always carry the new cookie's session by the time a client-side
      // route change reads it: `RequireAuth` reads a stale null session,
      // bounces to `/`, and SignIn.tsx's own (pre-existing) render-time
      // `navigate('/groups')` steals the destination once its session
      // catches up. A full load re-reads `/api/auth/get-session` fresh.
      window.location.href = `/g/${groupId}`;
    } catch (err) {
      setError(err instanceof ApiError ? err.reason : String(err));
      setAccepting(false);
    }
  }

  async function signInThenAccept(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const result =
      mode === 'signin'
        ? await authClient.signIn.email({ email, password })
        : await authClient.signUp.email({ email, password, name });
    if (result.error) {
      setError(result.error.message ?? 'sign in failed');
      return;
    }
    await accept();
  }

  if (state.kind === 'loading' || isPending) {
    return (
      <div className="page">
        <div data-testid="join-status">loading…</div>
      </div>
    );
  }
  if (state.kind === 'not-found') {
    return (
      <div className="page">
        <div data-testid="join-status">Invitation not found.</div>
      </div>
    );
  }
  if (state.kind === 'closed') {
    return (
      <div className="page">
        <div data-testid="join-status" className="error">
          {CLOSED_MESSAGE}
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <h1>join a group</h1>
      <div className="card">
        <div data-testid="join-status">
          <b>{state.groupName}</b> — invited by {state.inviterName}
        </div>
        {error && <div className="error">{error}</div>}

        {session ? (
          <button
            type="button"
            data-testid="join-accept"
            disabled={accepting}
            onClick={() => void accept()}
          >
            {accepting ? 'joining…' : `join as ${session.user.email}`}
          </button>
        ) : (
          <form className="card" onSubmit={(e) => void signInThenAccept(e)}>
            <div className="row">
              <button
                type="button"
                onClick={() => setMode('signin')}
                disabled={mode === 'signin'}
              >
                sign in
              </button>
              <button
                type="button"
                onClick={() => setMode('signup')}
                disabled={mode === 'signup'}
              >
                sign up
              </button>
            </div>
            {mode === 'signup' && (
              <div className="row">
                <label htmlFor="join-name">name</label>
                <input
                  id="join-name"
                  data-testid="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </div>
            )}
            <div className="row">
              <label htmlFor="join-email">email</label>
              <input
                id="join-email"
                data-testid="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div className="row">
              <label htmlFor="join-password">password</label>
              <input
                id="join-password"
                data-testid="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            <button type="submit" data-testid="submit">
              {mode === 'signin' ? 'sign in and join' : 'sign up and join'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
