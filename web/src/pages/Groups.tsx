import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { ApiError, api } from '../lib/api.ts';

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
    <div className="page">
      <h1>groups</h1>
      {error && <div className="error">{error}</div>}

      <div className="card">
        <h3>your groups</h3>
        <table data-testid="group-list">
          <tbody>
            {groups.map((g) => (
              <tr key={g.id}>
                <td>
                  <Link to={`/g/${g.id}`}>{g.name}</Link>
                </td>
                <td className="muted">{g.role}</td>
                <td>
                  <button
                    type="button"
                    onClick={() =>
                      setInviteFor(inviteFor === g.id ? null : g.id)
                    }
                  >
                    invite
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {inviteFor && (
          <div className="row">
            <input
              placeholder="email"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
            />
            <button type="button" onClick={() => void sendInvite(inviteFor)}>
              send invite
            </button>
            {lastInvitationId && (
              <span className="muted" data-testid="invitation-id">
                invitation id: {lastInvitationId}
              </span>
            )}
          </div>
        )}
      </div>

      <div className="card">
        <h3>create a group</h3>
        <form className="row" onSubmit={(e) => void createGroup(e)}>
          <input
            data-testid="group-name"
            placeholder="name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <button type="submit">create</button>
        </form>
      </div>

      <div className="card">
        <h3>accept an invitation</h3>
        <form className="row" onSubmit={(e) => void acceptInvitation(e)}>
          <input
            data-testid="invitation-input"
            placeholder="invitation id"
            value={acceptId}
            onChange={(e) => setAcceptId(e.target.value)}
          />
          <button type="submit">accept</button>
        </form>
      </div>
    </div>
  );
}
