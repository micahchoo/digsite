// "Copies of this picture" (CONTEXT.md "Near-duplicate"): the pictures on
// the board that are nearly this one, in meaning and in pixels. The
// machine only suggests. A person looks (each copy opens on the map),
// checks (Compare, side by side with a difference blend), or gathers them
// to act on together (Select them). Nothing is merged or removed.
import type { MeaningMatch } from '@digsite/shared/api';
import { useEffect, useState } from 'react';
import { ApiError, api } from '../lib/api.ts';

interface Props {
  boardId: string;
  sort: string;
  imageId: string;
  onShow: (imageId: string, rank: number) => void;
  onCompare: (copyId: string) => void;
  onSelect: (imageIds: string[]) => void;
}

export function Copies({
  boardId,
  sort,
  imageId,
  onShow,
  onCompare,
  onSelect,
}: Props) {
  const [copies, setCopies] = useState<MeaningMatch[] | null>(null);
  const [off, setOff] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setCopies(null);
    api
      .nearDuplicates(boardId, sort, imageId)
      .then(({ matches }) => {
        if (!cancelled) setCopies(matches);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Off, or this picture not read yet: say nothing rather than
        // promise copies that cannot be looked for.
        if (
          err instanceof ApiError &&
          (err.status === 503 || err.status === 409)
        )
          setOff(true);
        else setCopies([]);
      });
    return () => {
      cancelled = true;
    };
  }, [boardId, sort, imageId]);

  if (off || !copies || copies.length === 0) return null;
  return (
    <section className="board-panel-section board-copies" data-testid="copies">
      <div className="board-panel-heading">
        <h3>
          {copies.length === 1
            ? 'A copy of this picture'
            : `${copies.length} copies of this picture`}
        </h3>
      </div>
      <p className="board-copies-hint">
        Nearly the same in what it shows and in its pixels. Check before you
        treat them as one.
      </p>
      <ul className="board-copies-list">
        {copies.map((copy) => (
          <li key={copy.imageId}>
            <button
              type="button"
              className="board-copies-picture"
              data-testid="copies-show"
              aria-label="Show this copy on the map"
              onClick={() => onShow(copy.imageId, copy.rank)}
            >
              <img src={api.previewUrl(copy.imageId)} alt="" loading="lazy" />
            </button>
            <button
              type="button"
              data-testid="copies-compare"
              onClick={() => onCompare(copy.imageId)}
            >
              Compare
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        data-testid="copies-select"
        onClick={() => onSelect([imageId, ...copies.map((c) => c.imageId)])}
      >
        Select this picture and its copies
      </button>
    </section>
  );
}
