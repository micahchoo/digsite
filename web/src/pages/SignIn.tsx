import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { authClient, useSession } from '../lib/auth.ts';

export function SignIn() {
  const { data: session } = useSession();
  const navigate = useNavigate();
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Not called during render: `navigate` synchronously during render (the
  // previous shape here) warns "Cannot update a component while rendering
  // a different component" and races a caller that just navigated
  // elsewhere itself — a re-sign-in right after signing out landed back on
  // /groups instead of wherever the caller sent it, because this redirect
  // fired mid-render before the caller's own navigation settled (found via
  // Join.tsx's sign-up-then-accept flow, which re-signs-in as a different
  // fixture user and navigates straight to a protected route).
  useEffect(() => {
    if (session) navigate('/groups', { replace: true });
  }, [session, navigate]);
  if (session) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result =
        mode === 'signin'
          ? await authClient.signIn.email({ email, password })
          : await authClient.signUp.email({ email, password, name });
      if (result.error) {
        setError(result.error.message ?? 'sign in failed');
        return;
      }
      navigate('/groups');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <h1>digsite</h1>
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
      <form className="card" onSubmit={(e) => void submit(e)}>
        {mode === 'signup' && (
          <div className="row">
            <label htmlFor="name">name</label>
            <input
              id="name"
              data-testid="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>
        )}
        <div className="row">
          <label htmlFor="email">email</label>
          <input
            id="email"
            data-testid="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div className="row">
          <label htmlFor="password">password</label>
          <input
            id="password"
            data-testid="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        <button type="submit" data-testid="submit" disabled={busy}>
          {mode === 'signin' ? 'sign in' : 'sign up'}
        </button>
        {error && <div className="error">{error}</div>}
      </form>
    </div>
  );
}
