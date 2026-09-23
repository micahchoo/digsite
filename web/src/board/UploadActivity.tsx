import { useState } from 'react';
import {
  type UploadRow,
  type UploadSnapshot,
  VISIBLE_UPLOAD_ROWS,
  dismissUploadActivity,
  stopQueuedUploads,
} from './upload.ts';

const ROW_HEIGHT = 52;
const VIEWPORT_HEIGHT = 260;

export function UploadActivity({
  boardId,
  snapshot,
}: {
  boardId: string;
  snapshot: UploadSnapshot;
}) {
  const [firstRow, setFirstRow] = useState(0);
  const { rows, counts } = snapshot;
  if (!snapshot.visible || !rows.length) return null;

  const endRow = Math.min(rows.length, firstRow + VISIBLE_UPLOAD_ROWS);
  const visibleRows = rows.slice(firstRow, endRow);
  const busy = counts.queued > 0 || counts.uploading > 0;

  return (
    <section
      className="board-upload-queue"
      data-testid="upload-rows"
      aria-label="Image upload activity"
      aria-live="polite"
    >
      <div className="board-upload-heading">
        <div>
          <span className="board-eyebrow">UPLOAD ACTIVITY</span>
          <b>
            {busy
              ? 'Adding images'
              : counts.processing
                ? 'Processing images'
                : 'Recent uploads'}
          </b>
        </div>
        <div className="board-upload-counts" data-testid="upload-counts">
          <span>{counts.queued} queued</span>
          <span>{counts.uploading} uploading</span>
          <span>{counts.processing} processing</span>
          <span>{counts.ready} ready</span>
          <span>{counts.failed} failed</span>
          <span>{counts.unknown} unconfirmed</span>
          <span>{counts.canceled} canceled</span>
        </div>
        {counts.queued > 0 && (
          <button
            type="button"
            className="board-upload-cancel"
            data-testid="upload-cancel"
            onClick={() => stopQueuedUploads(boardId)}
          >
            Stop queued
          </button>
        )}
        {!busy && !counts.processing && (
          <button
            type="button"
            className="board-upload-close"
            aria-label="Dismiss upload activity"
            data-testid="upload-close"
            onClick={() => dismissUploadActivity(boardId)}
          >
            ×
          </button>
        )}
      </div>
      {snapshot.message && (
        <output className="board-upload-message" aria-live="polite">
          {snapshot.message}
        </output>
      )}
      <div
        className="board-upload-list"
        data-testid="upload-list"
        style={{ height: VIEWPORT_HEIGHT }}
        onScroll={(event) => {
          const element = event.currentTarget;
          setFirstRow(
            Math.min(
              Math.max(0, rows.length - VISIBLE_UPLOAD_ROWS),
              Math.floor(element.scrollTop / ROW_HEIGHT),
            ),
          );
        }}
        aria-label={`Upload files ${firstRow + 1} through ${endRow} of ${rows.length}`}
      >
        <div
          className="board-upload-spacer"
          style={{ height: rows.length * ROW_HEIGHT }}
          aria-hidden="true"
        />
        {visibleRows.map((row, index) => (
          <UploadRowView
            key={row.clientId}
            row={row}
            index={firstRow + index}
          />
        ))}
      </div>
      {rows.length > VISIBLE_UPLOAD_ROWS && (
        <div className="board-upload-window-note">
          Showing {firstRow + 1}–{endRow} of {rows.length} files
        </div>
      )}
    </section>
  );
}

function UploadRowView({ row, index }: { row: UploadRow; index: number }) {
  const reason = row.error;
  return (
    <div
      className="board-upload-row"
      data-testid="upload-row"
      data-upload-index={index}
      data-status={row.status}
      title={reason}
      style={{ top: index * ROW_HEIGHT, height: ROW_HEIGHT }}
    >
      <span className="board-upload-file-name">{row.name}</span>
      <span className="board-upload-method">
        {row.status === 'uploading' && row.method === 'tus'
          ? `${row.progress}%`
          : ''}
      </span>
      <span className="board-upload-state">
        {row.status === 'pending' ? 'processing' : row.status}
      </span>
      {reason && <span className="board-upload-reason">{reason}</span>}
    </div>
  );
}
