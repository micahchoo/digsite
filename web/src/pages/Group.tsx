import type { Role } from '@digsite/shared/api';
// The group home (docs/phases/3-groups.md sections 2 and 5). Boards with
// stats, recent sheets, invitations, and members with role management and
// leave. Allowlist management moved to Board.tsx (section 3) — a private
// board's allowlist is a property of the board, not the group.
//
// Every control here is shown to every member; the server decides who may
// actually use it (../.claude/rules/access-one-function-per-intent.md: "the
// web must never decide access; it shows what the server allows and
// handles 403 with the reason"). A row's own error, not a global banner, is
// where that reason lands.
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { ApiError, api } from '../lib/api.ts';
import { useSession } from '../lib/auth.ts';

const ROLES: Role[] = ['owner', 'admin', 'member'];

export function Group() {
  const { id } = useParams<{ id: string }>();
  const groupId = id ?? '';
  const { data: session } = useSession();

  const [boards, setBoards] = useState<
    Awaited<ReturnType<typeof api.listBoards>>
  >([]);
  const [recentSheets, setRecentSheets] = useState<
    Awaited<ReturnType<typeof api.listRecentSheets>>
  >([]);
  const [members, setMembers] = useState<
    Awaited<ReturnType<typeof api.listMembers>>
  >([]);
  const [pending, setPending] = useState<
    Awaited<ReturnType<typeof api.listPendingInvitations>>
  >([]);
  const [pendingError, setPendingError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [boardName, setBoardName] = useState('');
  const [boardOpen, setBoardOpen] = useState(true);

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [inviteCopied, setInviteCopied] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);

  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [leaveError, setLeaveError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [b, m, s] = await Promise.all([
        api.listBoards(groupId),
        api.listMembers(groupId),
        api.listRecentSheets(groupId),
      ]);
      setBoards(b);
      setMembers(m);
      setRecentSheets(s);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.reason : String(err));
    }
    try {
      setPending(await api.listPendingInvitations(groupId));
      setPendingError(null);
    } catch (err) {
      setPending([]);
      setPendingError(err instanceof ApiError ? err.reason : String(err));
    }
  }, [groupId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function createBoard(e: React.FormEvent) {
    e.preventDefault();
    if (!boardName.trim()) return;
    try {
      await api.createBoard(groupId, {
        name: boardName.trim(),
        open: boardOpen,
      });
      setBoardName('');
      setError(null);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.reason : String(err));
    }
  }

  async function sendInvite() {
    setInviteError(null);
    setInviteCopied(false);
    try {
      const { url } = await api.invite(groupId, {
        email: inviteEmail.trim() || '',
      });
      setInviteUrl(url);
      setInviteEmail('');
      await refresh();
    } catch (err) {
      setInviteError(err instanceof ApiError ? err.reason : String(err));
    }
  }

  async function copyInviteUrl() {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setInviteCopied(true);
    } catch {
      // clipboard access denied; the URL is still shown to copy by hand
    }
  }

  async function revokeInvitation(invitationId: string) {
    try {
      await api.revokeInvitation(invitationId);
      await refresh();
    } catch (err) {
      setPendingError(err instanceof ApiError ? err.reason : String(err));
    }
  }

  async function changeRole(userId: string, role: Role) {
    setRowError((prev) => ({ ...prev, [userId]: '' }));
    try {
      await api.updateMemberRole(groupId, userId, { role });
      await refresh();
    } catch (err) {
      setRowError((prev) => ({
        ...prev,
        [userId]: err instanceof ApiError ? err.reason : String(err),
      }));
    }
  }

  async function removeMember(userId: string) {
    setRowError((prev) => ({ ...prev, [userId]: '' }));
    try {
      await api.removeMember(groupId, userId);
      await refresh();
    } catch (err) {
      setRowError((prev) => ({
        ...prev,
        [userId]: err instanceof ApiError ? err.reason : String(err),
      }));
    }
  }

  async function leaveGroup() {
    setLeaveError(null);
    try {
      await api.leaveGroup(groupId);
      await refresh();
    } catch (err) {
      setLeaveError(err instanceof ApiError ? err.reason : String(err));
    }
  }

  return (
    <div className="page">
      <h1>group</h1>
      {error && <div className="error">{error}</div>}

      <div className="card">
        <h3>boards</h3>
        <table data-testid="board-list">
          <tbody>
            {boards.map((b) => (
              <tr key={b.id}>
                <td>
                  <Link to={`/b/${b.id}`}>{b.name}</Link>
                </td>
                <td className="muted">{b.open ? 'open' : 'private'}</td>
                <td className="muted">{b.imageCount} images</td>
                <td className="muted">{b.sheetCount} sheets</td>
                <td className="muted">
                  {b.lastActivity
                    ? new Date(b.lastActivity).toLocaleString()
                    : 'no activity'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>create a board</h3>
        <form className="row" onSubmit={(e) => void createBoard(e)}>
          <input
            data-testid="board-name"
            placeholder="name"
            value={boardName}
            onChange={(e) => setBoardName(e.target.value)}
          />
          <button type="submit">create</button>
        </form>
        <label className="row" style={{ marginBottom: 2 }}>
          <input
            type="radio"
            name="board-open"
            checked={boardOpen}
            onChange={() => setBoardOpen(true)}
          />
          <span>
            <b>Open</b> — every member of this group can see this board.
          </span>
        </label>
        <label className="row">
          <input
            type="radio"
            name="board-open"
            checked={!boardOpen}
            onChange={() => setBoardOpen(false)}
          />
          <span>
            <b>Private</b> — only the members you add to its allowlist can see
            it.
          </span>
        </label>
      </div>

      <div className="card">
        <h3>recent sheets</h3>
        {recentSheets.length === 0 && <div className="muted">none yet</div>}
        <ul
          style={{ listStyle: 'none', padding: 0 }}
          data-testid="recent-sheets"
        >
          {recentSheets.map((s) => (
            <li key={s.id} className="row">
              <Link to={`/s/${s.id}`}>{s.name}</Link>
              <span className="muted">on {s.boardName}</span>
              {s.savedAt && (
                <span className="muted">
                  {new Date(s.savedAt).toLocaleString()}
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>

      <div className="card">
        <h3>invite</h3>
        <div className="row">
          <input
            data-testid="invite-email"
            placeholder="email (optional)"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
          />
          <button
            type="button"
            data-testid="invite-send"
            onClick={() => void sendInvite()}
          >
            create invite link
          </button>
        </div>
        {inviteError && <div className="error">{inviteError}</div>}
        {inviteUrl && (
          <div className="row">
            <input
              data-testid="invite-url"
              readOnly
              value={inviteUrl}
              style={{ flex: 1 }}
            />
            <button
              type="button"
              data-testid="invite-copy"
              onClick={() => void copyInviteUrl()}
            >
              {inviteCopied ? 'copied' : 'copy'}
            </button>
          </div>
        )}

        <h4>pending</h4>
        {pendingError && <div className="error">{pendingError}</div>}
        {!pendingError && pending.length === 0 && (
          <div className="muted">none</div>
        )}
        <ul
          data-testid="pending-invitations"
          style={{ listStyle: 'none', padding: 0 }}
        >
          {pending.map((inv) => (
            <li key={inv.id} className="row">
              <span className="muted">{inv.email ?? '(link only)'}</span>
              <button
                type="button"
                data-testid={`revoke-${inv.id}`}
                onClick={() => void revokeInvitation(inv.id)}
              >
                revoke
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="card">
        <h3>members</h3>
        <table data-testid="member-list">
          <tbody>
            {members.map((m) => (
              <tr key={m.userId} data-testid={`member-row-${m.userId}`}>
                <td>{m.name}</td>
                <td className="muted">{m.email}</td>
                <td>
                  <select
                    data-testid={`role-select-${m.userId}`}
                    value={m.role}
                    onChange={(e) =>
                      void changeRole(m.userId, e.target.value as Role)
                    }
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <button
                    type="button"
                    data-testid={`remove-${m.userId}`}
                    onClick={() => void removeMember(m.userId)}
                  >
                    remove
                  </button>
                </td>
                <td className="error" data-testid={`member-error-${m.userId}`}>
                  {rowError[m.userId] ?? ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="row" style={{ marginTop: 8 }}>
          <button
            type="button"
            data-testid="leave-group"
            onClick={() => void leaveGroup()}
          >
            leave group
          </button>
          <span className="muted">
            {session?.user.email ? `signed in as ${session.user.email}` : ''}
          </span>
        </div>
        {leaveError && (
          <div className="error" data-testid="leave-error">
            {leaveError}
          </div>
        )}
      </div>
    </div>
  );
}
