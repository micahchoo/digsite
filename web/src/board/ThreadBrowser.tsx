import type { GroupThreadSummary } from '@digsite/shared/api';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../lib/api.ts';
import { plural } from '../lib/plural.ts';
import { notifySheetsChanged } from '../lib/sheetEvents.ts';
import { Participants } from './Participants.tsx';
import './threads.css';
import { Icon } from '../components/Icon.tsx';

export function ThreadBrowser({
  groupId,
  boardId,
  onChanged,
}: {
  groupId: string;
  boardId: string;
  onChanged: () => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [threads, setThreads] = useState<GroupThreadSummary[]>([]);
  const [query, setQuery] = useState('');
  const [view, setView] = useState('active');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision refetches after an archive action.
  useEffect(() => {
    if (!open) return;
    let current = true;
    setLoading(true);
    setError('');
    void api
      .listGroupThreads(groupId, true)
      .then((rows) => {
        if (current) setThreads(rows.filter((row) => row.boardId === boardId));
      })
      .catch(() => {
        if (current) setError('Could not load sheets. Try again.');
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [open, groupId, boardId, revision]);

  async function setArchived(thread: GroupThreadSummary) {
    setBusy(thread.id);
    setError('');
    try {
      if (thread.archived) await api.unarchiveSheet(thread.id);
      else await api.archiveSheet(thread.id);
      setRevision((value) => value + 1);
      notifySheetsChanged();
      await onChanged();
    } catch {
      setError('Could not update this sheet. Try again.');
    } finally {
      setBusy(null);
    }
  }

  const visible = threads.filter(
    (thread) =>
      (view === 'all' || thread.archived === (view === 'archived')) &&
      thread.name
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()),
  );

  return (
    <>
      <button
        type="button"
        data-testid="thread-browser-open"
        onClick={() => setOpen(true)}
      >
        Browse sheets
      </button>
      <dialog
        ref={dialog}
        className="thread-browser"
        data-testid="thread-browser"
        onClose={() => setOpen(false)}
        aria-labelledby="thread-browser-title"
      >
        <header className="thread-browser-heading">
          <div>
            <h2 id="thread-browser-title">Sheets on this board</h2>
            <p>Revisit a thread or reopen an archived sheet.</p>
          </div>
          <button
            type="button"
            aria-label="Close sheet browser"
            onClick={() => setOpen(false)}
          >
            <Icon name="close" size={16} />
          </button>
        </header>
        <div className="thread-browser-filters">
          <input
            type="search"
            aria-label="Find a sheet"
            placeholder="Find a sheet…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            data-testid="thread-search"
          />
          <select
            aria-label="Sheet status"
            value={view}
            onChange={(event) => setView(event.target.value)}
            data-testid="thread-status"
          >
            <option value="active">Active</option>
            <option value="archived">Archived</option>
            <option value="all">All sheets</option>
          </select>
        </div>
        {error && (
          <div role="alert" className="thread-browser-error">
            {error}{' '}
            <button
              type="button"
              onClick={() => setRevision((value) => value + 1)}
            >
              Retry
            </button>
          </div>
        )}
        {loading ? (
          <output>Loading sheets…</output>
        ) : (
          <ul className="thread-browser-list">
            {visible.map((thread) => (
              <li
                key={thread.id}
                data-testid="thread-row"
                data-sheet-id={thread.id}
              >
                <div className="thread-browser-identity">
                  <Link to={`/s/${thread.id}`} onClick={() => setOpen(false)}>
                    {thread.name}
                  </Link>
                  {thread.unread && (
                    <span className="thread-unread">Unread</span>
                  )}
                  {thread.archived && (
                    <span className="thread-archived">Archived</span>
                  )}
                  <Participants people={thread.participants ?? []} />
                  <span className="thread-browser-meta">
                    {plural(thread.imageCount, 'image')}
                    {thread.lastActivityAt && (
                      <>
                        {' '}
                        · {new Date(thread.lastActivityAt).toLocaleDateString()}
                      </>
                    )}
                  </span>
                </div>
                <div className="thread-browser-preview" aria-hidden="true">
                  {thread.previewImageIds.map((id) => (
                    <img
                      key={id}
                      src={api.previewUrl(id)}
                      alt=""
                      loading="lazy"
                    />
                  ))}
                </div>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void setArchived(thread)}
                  data-testid="thread-archive"
                >
                  {busy === thread.id
                    ? 'Saving…'
                    : thread.archived
                      ? 'Reopen'
                      : 'Archive'}
                </button>
              </li>
            ))}
            {visible.length === 0 && (
              <li className="thread-browser-empty">
                {query
                  ? 'No sheets match your search.'
                  : view === 'archived'
                    ? 'No archived sheets.'
                    : 'No sheets yet. Select images on the board to start one.'}
              </li>
            )}
          </ul>
        )}
      </dialog>
    </>
  );
}
