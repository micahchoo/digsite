// The board itself, at the foot of the right column: whether it is open to
// the whole group, deleting it, and a private board's allowlist
// (docs/phases/3-groups.md sections 3 and 4). None of it shares anything
// with the map, so none of it lives on the map page.
import type {
  BoardFootprint,
  GetBoardAllowlistResponse,
  GetBoardResponse,
} from '@digsite/shared';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { Confirm } from '../components/Confirm.tsx';
import { ApiError, api } from '../lib/api.ts';
import { boardDeleteMessage } from './messages.ts';

const reasonOf = (err: unknown) =>
  err instanceof ApiError ? err.reason : String(err);

export function BoardAdministration({ board }: { board: GetBoardResponse }) {
  const navigate = useNavigate();
  const [footprint, setFootprint] = useState<BoardFootprint | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function askDelete() {
    setError(null);
    try {
      setFootprint(await api.getBoardFootprint(board.id));
    } catch (err) {
      setError(reasonOf(err));
    }
  }
  async function confirmDelete() {
    setBusy(true);
    try {
      await api.deleteBoard(board.id);
      navigate(`/g/${board.groupId}`);
    } catch (err) {
      setError(reasonOf(err));
      setBusy(false);
    }
  }

  return (
    <section className="board-panel-section">
      <header className="board-panel-heading">
        <h2>Board</h2>
      </header>
      <div className="board-about">
        <span className="board-open-status" data-open={board.open}>
          <span aria-hidden="true" />
          {board.open ? 'Open to the whole group' : 'Private board'}
        </span>
        <button
          type="button"
          className="board-danger-link"
          data-testid="board-delete"
          onClick={() => void askDelete()}
        >
          Delete board
        </button>
      </div>
      {error && !footprint && <div className="error">{error}</div>}
      {footprint && (
        <Confirm
          testId="board-delete-confirm"
          message={boardDeleteMessage(board.name, footprint)}
          busy={busy}
          error={error}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setFootprint(null)}
        />
      )}
      {!board.open && <Allowlist board={board} />}
    </section>
  );
}

/** Who may see a private board, beyond its group's owners and admins. */
function Allowlist({ board }: { board: GetBoardResponse }) {
  const [allowlist, setAllowlist] = useState<GetBoardAllowlistResponse | null>(
    null,
  );
  const [members, setMembers] = useState<
    Awaited<ReturnType<typeof api.listMembers>>
  >([]);
  const [pick, setPick] = useState('');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [al, gm] = await Promise.all([
        api.getBoardAllowlist(board.id),
        api.listMembers(board.groupId),
      ]);
      setAllowlist(al);
      setMembers(gm);
      setError(null);
    } catch (err) {
      setError(reasonOf(err));
    }
  }, [board.id, board.groupId]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function change(write: () => Promise<unknown>) {
    setError(null);
    try {
      await write();
      await refresh();
    } catch (err) {
      setError(reasonOf(err));
    }
  }

  const listed = allowlist?.members ?? [];
  return (
    <div className="board-allowlist" data-testid="allowlist-card">
      <h3>Allowlist</h3>
      {error && <div className="error">{error}</div>}
      <ul data-testid="allowlist-table">
        {listed.map((m) => (
          <li key={m.userId} className="board-allowlist-row">
            <span className="board-allowlist-name">{m.name}</span>
            <span className="board-allowlist-role">{m.role}</span>
            <button
              type="button"
              className="board-quiet-button"
              data-testid={`allowlist-remove-${m.userId}`}
              aria-label={`Remove ${m.name} from the allowlist`}
              onClick={() =>
                void change(() => api.removeFromAllowlist(board.id, m.userId))
              }
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      <div className="board-allowlist-add">
        <select
          data-testid="allowlist-add-select"
          aria-label="Member to add"
          value={pick}
          onChange={(e) => setPick(e.target.value)}
        >
          <option value="">Choose a member…</option>
          {members
            .filter((m) => !listed.some((x) => x.userId === m.userId))
            .map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.email}
              </option>
            ))}
        </select>
        <button
          type="button"
          data-testid="allowlist-add"
          disabled={!pick}
          onClick={() => {
            const userId = pick;
            setPick('');
            if (userId)
              void change(() => api.addToAllowlist(board.id, { userId }));
          }}
        >
          Add
        </button>
      </div>
    </div>
  );
}
