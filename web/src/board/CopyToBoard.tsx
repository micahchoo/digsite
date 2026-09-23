// Copy pictures to another of the group's boards (POST
// /boards/:target/images/copy): the originals and their properties, never
// the claims made on them. A picture already on the target is skipped, not
// stored twice; a full group says how full, as the upload queue does.
import { useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../lib/api.ts';
import { bytesLabel } from '../lib/bytes.ts';
import { plural } from '../lib/plural.ts';
import { quotaOf } from './upload.ts';

type Outcome = { copied: number; skipped: number; message?: string };

export function CopyToBoard({
  boardId,
  groupId,
  imageIds,
  onClose,
}: {
  boardId: string;
  groupId: string;
  imageIds: readonly string[];
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [boards, setBoards] = useState<{ id: string; name: string }[] | null>(
    null,
  );
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  useEffect(() => {
    dialogRef.current?.showModal();
    void api
      .listBoards(groupId)
      .then((all) => {
        const others = all.filter((b) => b.id !== boardId);
        setBoards(others);
        setTarget(others[0]?.id ?? '');
      })
      .catch((err: unknown) => {
        setBoards([]);
        setError(err instanceof ApiError ? err.reason : String(err));
      });
  }, [boardId, groupId]);

  async function copy() {
    if (!target) return;
    setBusy(true);
    setError('');
    try {
      const res = await api.copyImages(target, {
        fromBoardId: boardId,
        imageIds: [...imageIds],
      });
      setOutcome({ copied: res.images.length, skipped: res.skipped.length });
    } catch (err) {
      const quota =
        err instanceof ApiError && err.status === 413
          ? quotaOf(err.body)
          : null;
      if (quota)
        setOutcome({
          copied: quota.accepted?.length ?? 0,
          skipped: 0,
          message: `That board's group is out of storage (${bytesLabel(quota.usedBytes)} of ${bytesLabel(quota.quotaBytes)}), so the rest were not copied.`,
        });
      else setError(err instanceof ApiError ? err.reason : String(err));
    } finally {
      setBusy(false);
    }
  }

  const targetName = boards?.find((b) => b.id === target)?.name ?? '';
  return (
    <dialog
      ref={dialogRef}
      className="board-folder-dialog"
      data-testid="copy-to-board"
      aria-labelledby="copy-to-board-title"
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (outcome) dialogRef.current?.close();
          else void copy();
        }}
      >
        <h2 id="copy-to-board-title">
          Copy {plural(imageIds.length, 'picture')} to another board
        </h2>
        <p>
          The pictures and their properties are copied. What sheets say about
          them stays on this board.
        </p>
        {boards === null ? (
          <p>Loading the group's boards…</p>
        ) : boards.length === 0 ? (
          <p>This group has no other board to copy to.</p>
        ) : (
          <>
            <label htmlFor="copy-to-board-target">Board</label>
            <select
              id="copy-to-board-target"
              data-testid="copy-to-board-target"
              value={target}
              disabled={busy || outcome !== null}
              onChange={(e) => setTarget(e.target.value)}
            >
              {boards.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </>
        )}
        {outcome && (
          <output data-testid="copy-to-board-outcome">
            {outcome.copied
              ? `Copied ${plural(outcome.copied, 'picture')} to ${targetName}.`
              : `Nothing new was copied to ${targetName}.`}
            {outcome.skipped
              ? ` ${plural(outcome.skipped, 'picture')} ${outcome.skipped === 1 ? 'was' : 'were'} already there.`
              : ''}
            {outcome.message ? ` ${outcome.message}` : ''}
          </output>
        )}
        {error && (
          <p className="board-folder-error" role="alert">
            {error}
          </p>
        )}
        <div className="board-folder-actions">
          {!outcome && (
            <button type="button" onClick={() => dialogRef.current?.close()}>
              Cancel
            </button>
          )}
          <button
            type="submit"
            className="board-primary-button"
            data-testid="copy-to-board-confirm"
            disabled={!outcome && (!target || busy)}
          >
            {outcome ? 'Done' : busy ? 'Copying…' : 'Copy'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
