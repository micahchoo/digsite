import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Icon } from '../components/Icon.tsx';
import { ApiError, api } from '../lib/api.ts';
import './groups.css';

export function Groups() {
  const [groups, setGroups] = useState<
    Awaited<ReturnType<typeof api.listGroups>>
  >([]);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [inviteFor, setInviteFor] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [lastInvitationId, setLastInvitationId] = useState<string | null>(null);
  const [acceptId, setAcceptId] = useState('');

  const refresh = useCallback(async () => {
    try {
      setGroups(await api.listGroups());
    } catch (err) {
      setError(err instanceof ApiError ? err.reason : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function createGroup(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    await api.createGroup({ name: newName.trim() });
    setNewName('');
    await refresh();
  }

  async function sendInvite(groupId: string) {
    if (!inviteEmail.trim()) return;
    const { invitationId } = await api.invite(groupId, {
      email: inviteEmail.trim(),
    });
    setLastInvitationId(invitationId);
    setInviteEmail('');
  }

  async function acceptInvitation(e: React.FormEvent) {
    e.preventDefault();
    if (!acceptId.trim()) return;
    await api.acceptInvitation(acceptId.trim());
    setAcceptId('');
    await refresh();
  }

  return (
    <main className="page groups-home">
      <header className="groups-heading">
        <div>
          <div className="groups-eyebrow">DIGSITE / WORKSPACES</div>
          <h1>Your groups</h1>
          <p>Shared places for image collections and investigations.</p>
        </div>
        <span className="groups-total" aria-label={`${groups.length} groups`}>
          {groups.length} <span>groups</span>
        </span>
      </header>
      {error && <div className="error groups-error">{error}</div>}

      <div className="groups-layout">
        <section
          className="groups-section"
          aria-labelledby="groups-list-heading"
        >
          <div className="groups-section-heading">
            <div>
              <h2 id="groups-list-heading">Workspaces</h2>
              <p>Choose a group to pick up where your team left off.</p>
            </div>
          </div>
          {groups.length ? (
            <ul className="groups-list" data-testid="group-list">
              {groups.map((g) => (
                <li className="groups-item" key={g.id}>
                  <Link className="groups-item-main" to={`/g/${g.id}`}>
                    <span className="groups-mark" aria-hidden="true">
                      {g.name.trim().charAt(0).toUpperCase() || '?'}
                    </span>
                    <span className="groups-item-copy">
                      <span className="groups-item-name">{g.name}</span>
                      <span className="groups-item-hint">Open workspace</span>
                    </span>
                    <span className="groups-role">{g.role}</span>
                    <Icon
                      name="arrowRight"
                      size={16}
                      className="groups-arrow"
                    />
                  </Link>
                  <button
                    className="groups-invite-toggle"
                    type="button"
                    aria-expanded={inviteFor === g.id}
                    onClick={() =>
                      setInviteFor(inviteFor === g.id ? null : g.id)
                    }
                  >
                    {inviteFor === g.id ? 'Close' : 'Invite'}
                  </button>
                  {inviteFor === g.id && (
                    <form
                      className="groups-invite-form"
                      id={`invite-${g.id}`}
                      onSubmit={(e) => {
                        e.preventDefault();
                        void sendInvite(g.id);
                      }}
                    >
                      <label
                        className="groups-label"
                        htmlFor={`invite-email-${g.id}`}
                      >
                        Invite by email
                      </label>
                      <input
                        id={`invite-email-${g.id}`}
                        type="email"
                        placeholder="name@example.com"
                        value={inviteEmail}
                        onChange={(e) => setInviteEmail(e.target.value)}
                      />
                      <button type="submit">Send invitation</button>
                      {lastInvitationId && (
                        <span className="muted" data-testid="invitation-id">
                          Invitation created: {lastInvitationId}
                        </span>
                      )}
                    </form>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <div className="groups-empty">
              <span className="groups-empty-mark" aria-hidden="true">
                <Icon name="home" size={21} />
              </span>
              <h3>No workspaces yet</h3>
              <p>Create one for your team, or join with an invitation.</p>
            </div>
          )}
        </section>

        <aside className="groups-actions" aria-label="Workspace actions">
          <section className="groups-action-panel">
            <span className="groups-action-index">01</span>
            <h2>Create a group</h2>
            <p>Start a shared space for your team.</p>
            <form className="groups-form" onSubmit={(e) => void createGroup(e)}>
              <label className="groups-label" htmlFor="new-group-name">
                Group name
              </label>
              <div className="groups-form-row">
                <input
                  id="new-group-name"
                  data-testid="group-name"
                  placeholder="e.g. Coastal survey"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                />
                <button type="submit">Create</button>
              </div>
            </form>
          </section>
          <section className="groups-action-panel groups-join-panel">
            <span className="groups-action-index">02</span>
            <h2>Join a group</h2>
            <p>Enter the invitation code your teammate shared.</p>
            <form
              className="groups-form"
              onSubmit={(e) => void acceptInvitation(e)}
            >
              <label className="groups-label" htmlFor="accept-invitation">
                Invitation code
              </label>
              <div className="groups-form-row">
                <input
                  id="accept-invitation"
                  data-testid="invitation-input"
                  placeholder="Paste invitation code"
                  value={acceptId}
                  onChange={(e) => setAcceptId(e.target.value)}
                />
                <button type="submit">Join</button>
              </div>
            </form>
          </section>
        </aside>
      </div>
    </main>
  );
}
