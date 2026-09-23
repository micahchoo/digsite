import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router';
import { getUploadOverview, subscribeUploadOverview } from '../board/upload.ts';
import { api } from '../lib/api.ts';

/** Background uploads remain discoverable when their board is not open. */
export function UploadIndicator() {
  const queues = useSyncExternalStore(
    subscribeUploadOverview,
    getUploadOverview,
  );
  const [names, setNames] = useState<Record<string, string>>({});
  const details = useRef<HTMLDetailsElement>(null);
  const boardsKey = queues.map((queue) => queue.boardId).join(',');
  useEffect(() => {
    let current = true;
    for (const id of boardsKey.split(',').filter(Boolean)) {
      void api
        .getBoard(id)
        .then((board) => {
          if (current)
            setNames((previous) => ({ ...previous, [id]: board.name }));
        })
        .catch(() => {});
    }
    return () => {
      current = false;
    };
  }, [boardsKey]);
  if (!queues.length) return null;
  const remaining = queues.reduce(
    (count, queue) =>
      count +
      queue.counts.queued +
      queue.counts.uploading +
      queue.counts.processing,
    0,
  );
  const attention = queues.reduce(
    (count, queue) => count + queue.counts.failed + queue.counts.unknown,
    0,
  );
  return (
    <details
      ref={details}
      className="shell-upload-status"
      data-testid="global-upload-status"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && details.current) {
          details.current.open = false;
          details.current.querySelector('summary')?.focus();
        }
      }}
    >
      <summary
        aria-label={
          remaining
            ? `${remaining.toLocaleString()} images uploading or processing`
            : `${attention.toLocaleString()} uploads need attention`
        }
      >
        {remaining ? '↑' : '!'}{' '}
        <span className="shell-upload-label">Uploads </span>
        {(remaining || attention).toLocaleString()}
      </summary>
      <ul>
        {queues.map(({ boardId, counts }) => (
          <li key={boardId}>
            <Link
              to={`/b/${boardId}`}
              onClick={() => {
                if (details.current) details.current.open = false;
              }}
            >
              {names[boardId] ?? 'View uploading board'}
            </Link>
            <span>
              {counts.queued.toLocaleString()} queued · {counts.uploading}{' '}
              uploading · {counts.processing.toLocaleString()} processing
            </span>
            <span>
              {counts.ready.toLocaleString()} ready
              {counts.failed + counts.unknown
                ? ` · ${counts.failed + counts.unknown} need attention`
                : ''}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}
