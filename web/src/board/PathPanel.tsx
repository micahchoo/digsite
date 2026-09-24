// "How are these two connected?" The shortest chain of claims between two
// pictures, across every sheet on the board, one step per line: picture,
// relation, picture. Searches three steps out from each end (the
// neighbourhood route's limit), so it finds any chain up to six steps.
import type { BoardImageWithRank, EdgeRow } from '@digsite/shared';
import { type PathStep, shortestPath } from '@digsite/shared';
import { useEffect, useState } from 'react';
import { Icon } from '../components/Icon.tsx';
import { api } from '../lib/api.ts';

interface Props {
  boardId: string;
  sort: string;
  a: { id: string; name: string };
  b: { id: string; name: string };
  /** The chain's pictures in order, with their ranks, for the map. */
  onPath: (images: BoardImageWithRank[]) => void;
  onShowImage: (imageId: string, rank: number) => void;
  /** Opens the web around both pictures. */
  onOpenWeb?: () => void;
  onClose: () => void;
}

type State =
  | { kind: 'searching' }
  | {
      kind: 'found';
      steps: PathStep[];
      images: Map<string, BoardImageWithRank>;
    }
  | { kind: 'none'; truncated: boolean }
  | { kind: 'failed'; message: string };

const MAX_STEPS = 6;

export function PathPanel({
  boardId,
  sort,
  a,
  b,
  onPath,
  onShowImage,
  onOpenWeb,
  onClose,
}: Props) {
  const [state, setState] = useState<State>({ kind: 'searching' });

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new pair or sort is a new question; onPath is a callback
  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'searching' });
    void (async () => {
      try {
        const [fromA, fromB] = await Promise.all([
          api.getNeighbourhood(boardId, a.id, 3),
          api.getNeighbourhood(boardId, b.id, 3),
        ]);
        const edges: EdgeRow[] = [...fromA.edges, ...fromB.edges];
        const steps = shortestPath(edges, a.id, b.id);
        if (cancelled) return;
        if (!steps || steps.length > MAX_STEPS) {
          onPath([]);
          setState({
            kind: 'none',
            truncated: fromA.truncated || fromB.truncated,
          });
          return;
        }
        const ids = [a.id, ...steps.map((s) => s.to)];
        const { images } = await api.getBoardImagesByIds(boardId, sort, ids);
        if (cancelled) return;
        const byId = new Map(images.map((img) => [img.id, img]));
        onPath(
          ids.flatMap((id) => {
            const img = byId.get(id);
            return img ? [img] : [];
          }),
        );
        setState({ kind: 'found', steps, images: byId });
      } catch (err) {
        if (!cancelled)
          setState({
            kind: 'failed',
            message: err instanceof Error ? err.message : 'The search failed.',
          });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [boardId, sort, a.id, b.id]);

  const picture = (id: string, images: Map<string, BoardImageWithRank>) => {
    const img = images.get(id);
    return (
      <button
        type="button"
        className="board-path-picture"
        data-testid="board-path-picture"
        onClick={() => img && onShowImage(id, img.rank ?? -1)}
      >
        <img src={api.previewUrl(id)} alt="" loading="lazy" />
        <span>{img?.name ?? 'Picture'}</span>
      </button>
    );
  };

  return (
    <section
      className="board-panel-section board-path"
      data-testid="board-path"
      aria-live="polite"
    >
      <div className="board-panel-heading">
        <h3>How they are connected</h3>
        <button
          type="button"
          className="board-icon-button board-icon-button--small"
          aria-label="Close"
          onClick={() => {
            onPath([]);
            onClose();
          }}
        >
          <Icon name="close" size={16} />
        </button>
      </div>
      {state.kind === 'searching' && <p>Searching up to six steps…</p>}
      {state.kind === 'failed' && <p role="alert">{state.message}</p>}
      {state.kind === 'none' && (
        <p data-testid="board-path-none">
          {a.name} and {b.name} are not connected within six steps.
          {state.truncated
            ? ' The search stopped at 150 pictures around one of them, so a longer chain may exist.'
            : ''}
        </p>
      )}
      {state.kind === 'found' && (
        <>
          <p className="board-path-summary" data-testid="board-path-summary">
            {state.steps.length === 1
              ? 'Directly, in one step.'
              : `${state.steps.length} steps apart.`}
          </p>
          <ol className="board-path-steps">
            <li>{picture(a.id, state.images)}</li>
            {state.steps.map((step) => (
              <li key={step.edge.id}>
                <div className="board-path-link" data-testid="board-path-link">
                  <Icon
                    name={
                      step.edge.direction === 'none'
                        ? 'minus'
                        : step.edge.direction === 'both'
                          ? 'arrowBoth'
                          : step.forward === (step.edge.direction === 'forward')
                            ? 'arrowDown'
                            : 'arrowUp'
                    }
                    size={14}
                  />
                  <b>{step.edge.relation || 'unnamed'}</b>
                  {step.edge.confidence && (
                    <span data-confidence={step.edge.confidence}>
                      {step.edge.confidence}
                    </span>
                  )}
                  {step.others > 0 && (
                    <span className="board-path-others">
                      +{step.others} more on this pair
                    </span>
                  )}
                </div>
                {picture(step.to, state.images)}
              </li>
            ))}
          </ol>
        </>
      )}
      {onOpenWeb && state.kind !== 'searching' && (
        <button
          type="button"
          className="board-path-web"
          data-testid="board-path-web"
          onClick={onOpenWeb}
        >
          See the web around both
        </button>
      )}
    </section>
  );
}
