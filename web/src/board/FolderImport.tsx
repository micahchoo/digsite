// Import a folder the server can already read (POST /boards/:id/imports).
// For an archive of tens of thousands of files a browser upload is the wrong
// road: the files are on the server's disk, or a disk mounted there. This
// asks for the folder, starts the import, and follows it until it is done.
//
// The server imports in the background, so the card can close and the work
// goes on; the map refreshes as pictures arrive.
import type { FolderImport as Import } from '@digsite/shared';
import { useEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon.tsx';
import { ApiError, api } from '../lib/api.ts';

interface Props {
  boardId: string;
  onClose: () => void;
  /** More pictures have landed: refresh the map. */
  onProgress: () => void;
}

const POLL_MS = 1000;

/** The end of a long path: the folder's own name is what a person looks
 * for, and it is at the end. */
function tail(path: string, max = 44): string {
  return path.length <= max ? path : `…${path.slice(-(max - 1))}`;
}

/** What a refused import says, in words a person can act on. */
export function importFailure(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 503)
      return 'This server does not import folders. Whoever runs it can allow folders with IMPORT_ROOTS.';
    if (err.status === 403)
      return 'That folder is outside the folders this server may read, or you may not add images to this board.';
    if (err.status === 400) return 'There is no folder at that path.';
    if (err.status === 413)
      return 'That folder holds more files than one import may take. Import a smaller folder.';
    return err.reason;
  }
  return err instanceof Error ? err.message : 'The import could not start.';
}

export function FolderImport({ boardId, onClose, onProgress }: Props) {
  const [path, setPath] = useState('');
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const [job, setJob] = useState<Import | null>(null);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  /** Set before the dialog closes on a start, so that close is not read
   * as Cancel. */
  const startedRef = useRef(false);
  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open && !job) dialog.showModal();
  }, [job]);

  // Follow a running import; refresh the map whenever more have landed.
  const jobId = job?.id;
  const running = job?.state === 'running';
  useEffect(() => {
    if (!jobId || !running) return;
    let cancelled = false;
    let landed = -1;
    const timer = window.setInterval(() => {
      void api
        .getFolderImport(boardId, jobId)
        .then((next) => {
          if (cancelled) return;
          setJob(next);
          if (next.imported !== landed) {
            landed = next.imported;
            onProgressRef.current();
          }
        })
        .catch(() => {});
    }, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [boardId, jobId, running]);

  async function start() {
    const folder = path.trim();
    if (!folder) return;
    setStarting(true);
    setError('');
    try {
      const started = await api.startFolderImport(boardId, folder);
      startedRef.current = true;
      dialogRef.current?.close();
      setJob(started);
    } catch (err) {
      setError(importFailure(err));
    } finally {
      setStarting(false);
    }
  }

  async function resume() {
    if (!job) return;
    setStarting(true);
    setError('');
    try {
      setJob(await api.resumeFolderImport(boardId, job.id));
    } catch (err) {
      setError(importFailure(err));
    } finally {
      setStarting(false);
    }
  }

  if (!job) {
    return (
      <dialog
        ref={dialogRef}
        className="board-folder-dialog"
        data-testid="folder-import-dialog"
        aria-labelledby="folder-import-title"
        onClose={() => {
          if (!startedRef.current) onClose();
        }}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void start();
          }}
        >
          <h2 id="folder-import-title">Import a folder from the server</h2>
          <p>
            For a folder on the server's own disk: faster than uploading, and
            the browser can close while it runs.
          </p>
          <label htmlFor="folder-import-path">Folder path on the server</label>
          <input
            id="folder-import-path"
            data-testid="folder-import-path"
            placeholder="/srv/archive/2019"
            value={path}
            // biome-ignore lint/a11y/noAutofocus: the dialog exists to take this one field
            autoFocus
            onChange={(e) => setPath(e.target.value)}
          />
          {error && (
            <p className="board-folder-error" role="alert">
              {error}
            </p>
          )}
          <div className="board-folder-actions">
            <button type="button" onClick={() => dialogRef.current?.close()}>
              Cancel
            </button>
            <button
              type="submit"
              className="board-primary-button"
              data-testid="folder-import-start"
              disabled={!path.trim() || starting}
            >
              {starting ? 'Starting…' : 'Start import'}
            </button>
          </div>
        </form>
      </dialog>
    );
  }

  const handled = job.imported + job.skipped + job.unchanged;
  const percent = job.total ? Math.round((handled / job.total) * 100) : 100;
  return (
    <section
      className="board-folder-card"
      data-testid="folder-import"
      data-state={job.state}
      aria-label="Folder import"
    >
      <header>
        <div>
          <span className="board-eyebrow">FOLDER IMPORT</span>
          <b title={job.path}>{tail(job.path)}</b>
        </div>
        <button
          type="button"
          className="board-icon-button board-icon-button--small"
          aria-label={
            job.state === 'running'
              ? 'Hide; the import goes on'
              : 'Close folder import'
          }
          onClick={onClose}
        >
          <Icon name="close" size={16} />
        </button>
      </header>
      <progress max={job.total || 1} value={handled} aria-label="Imported" />
      <output data-testid="folder-import-counts">
        {job.state === 'done' ? 'Done: ' : ''}
        {job.imported} of {job.total} imported
        {job.unchanged ? `, ${job.unchanged} unchanged` : ''}
        {job.skipped ? `, ${job.skipped} skipped` : ''}
        {job.state === 'running' ? ` · ${percent}%` : ''}
      </output>
      {job.state === 'stopped' && (
        <div
          className="board-folder-stopped"
          data-testid="folder-import-stopped"
        >
          <p role="alert">
            Stopped: {job.stopReason ?? 'the import could not go on'}. The files
            not yet imported wait; resume once there is room.
          </p>
          {error && <p className="board-folder-error">{error}</p>}
          <button
            type="button"
            data-testid="folder-import-resume"
            onClick={() => void resume()}
            disabled={starting}
          >
            {starting ? 'Resuming…' : 'Resume'}
          </button>
        </div>
      )}
      {job.skips.length > 0 && (
        <details>
          <summary>Why files were skipped</summary>
          <ul>
            {job.skips.map((skip) => (
              <li key={skip.file}>
                <span>{skip.file}</span> {skip.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
