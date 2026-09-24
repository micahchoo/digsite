// Settings › Accounts: the site's operator (OPERATOR_EMAILS on the server)
// sees every account and can give a person a new password. The person's
// sessions end; nothing is emailed, so the operator hands the password
// over themselves. Anyone else is told this page is not theirs.
import type { Account } from '@digsite/shared/api';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '../lib/api.ts';
import './groups.css';

const MIN_PASSWORD = 10;

export function Accounts() {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resetting, setResetting] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setAccounts(await api.listAccounts());
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 403
          ? 'Only the site operator can see accounts.'
          : err instanceof ApiError
            ? err.reason
            : String(err),
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function setNewPassword(e: React.FormEvent, account: Account) {
    e.preventDefault();
    try {
      await api.setAccountPassword(account.id, { password });
      setDone(
        `${account.name || account.email} has a new password, and every session they had has ended. Give them the password yourself.`,
      );
      setResetting(null);
      setPassword('');
    } catch (err) {
      setError(err instanceof ApiError ? err.reason : String(err));
    }
  }

  return (
    <main className="page groups-home" data-testid="accounts-page">
      <header className="groups-heading">
        <div>
          <div className="groups-eyebrow">DIGSITE / SETTINGS</div>
          <h1>Accounts</h1>
          <p>Everyone who can sign in to this site.</p>
        </div>
        {accounts && (
          <span className="groups-total">
            {accounts.length} <span>accounts</span>
          </span>
        )}
      </header>
      {error && <div className="error groups-error">{error}</div>}
      {done && (
        <output className="muted" data-testid="accounts-done">
          {done}
        </output>
      )}
      {accounts && (
        <ul className="groups-list" data-testid="accounts-list">
          {accounts.map((a) => (
            <li className="groups-item" key={a.id}>
              <div className="groups-item-main">
                <span className="groups-mark" aria-hidden="true">
                  {(a.name || a.email).charAt(0).toUpperCase()}
                </span>
                <span className="groups-item-copy">
                  <span className="groups-item-name">{a.name || a.email}</span>
                  <span className="groups-item-hint">
                    {a.email} · {a.groups} {a.groups === 1 ? 'group' : 'groups'}{' '}
                    · joined {new Date(a.createdAt).toLocaleDateString()}
                  </span>
                </span>
              </div>
              <button
                className="groups-invite-toggle"
                type="button"
                aria-expanded={resetting === a.id}
                data-testid={`accounts-reset-${a.email}`}
                onClick={() => {
                  setResetting(resetting === a.id ? null : a.id);
                  setPassword('');
                  setDone(null);
                  setError(null);
                }}
              >
                {resetting === a.id ? 'Cancel' : 'Set a new password'}
              </button>
              {resetting === a.id && (
                <form
                  className="groups-invite-form"
                  onSubmit={(e) => void setNewPassword(e, a)}
                >
                  <label htmlFor={`pw-${a.id}`}>
                    New password for {a.name || a.email}
                  </label>
                  <input
                    id={`pw-${a.id}`}
                    type="text"
                    autoComplete="off"
                    minLength={MIN_PASSWORD}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    data-testid="accounts-new-password"
                  />
                  <button
                    type="submit"
                    disabled={password.length < MIN_PASSWORD}
                    data-testid="accounts-save-password"
                  >
                    Set password and sign them out
                  </button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
