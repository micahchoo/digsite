import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { ApiError, api } from '../lib/api.ts';

export function Group() {
  const { id } = useParams<{ id: string }>();
  const groupId = id ?? '';

  const [boards, setBoards] = useState<
    Awaited<ReturnType<typeof api.listBoards>>
  >([]);
  const [members, setMembers] = useState<
    Awaited<ReturnType<typeof api.listMembers>>
  >([]);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [open, setOpen] = useState(true);
  const [allowlistPick, setAllowlistPick] = useState<Record<string, string>>(
    {},
  );

  const refresh = useCallback(async () => {
    try {
      const [b, m] = await Promise.all([
        api.listBoards(groupId),
        api.listMembers(groupId),
      ]);
      setBoards(b);
      setMembers(m);
    } catch (err) {
      setError(err instanceof ApiError ? err.reason : String(err));
    }
  }, [groupId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function createBoard(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    await api.createBoard(groupId, { name: name.trim(), open });
    setName('');
    await refresh();
  }

  async function addToAllowlist(boardId: string) {
    const userId = allowlistPick[boardId];
    if (!userId) return;
    try {
      await api.addToAllowlist(boardId, { userId });
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.reason : String(err));
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
                {!b.open && (
                  <td>
                    <select
                      value={allowlistPick[b.id] ?? ''}
                      onChange={(e) =>
                        setAllowlistPick((prev) => ({
                          ...prev,
                          [b.id]: e.target.value,
                        }))
                      }
                    >
                      <option value="">add member…</option>
                      {members.map((m) => (
                        <option key={m.userId} value={m.userId}>
                          {m.email}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => void addToAllowlist(b.id)}
                    >
                      add to allowlist
                    </button>
                  </td>
                )}
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
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <label>
            <input
              type="checkbox"
              checked={open}
              onChange={(e) => setOpen(e.target.checked)}
            />
            open
          </label>
          <button type="submit">create</button>
        </form>
      </div>

      <div className="card">
        <h3>members</h3>
        <table data-testid="member-list">
          <tbody>
            {members.map((m) => (
              <tr key={m.userId}>
                <td>{m.name}</td>
                <td className="muted">{m.email}</td>
                <td className="muted">{m.role}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
