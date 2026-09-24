// The web around a picture: every claim within one to three steps, across
// all sheets, laid out on hop rings (web-layout.ts) with the starting
// picture in the middle. A web you can walk: click a picture to see what it
// is, walk from it to put it in the middle, or show it on the board.
// image-graph's exploration, over the board's union of claims.
import type {
  BoardImageWithRank,
  EdgeRow,
  GetNeighbourhoodResponse,
} from '@digsite/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../components/Icon.tsx';
import { api } from '../lib/api.ts';
import { WebDiagram, type WebDiagramHandle } from './WebDiagram.tsx';
import { ringLayout } from './web-layout.ts';

interface Props {
  boardId: string;
  sort: string;
  /** The starting pictures: one, or a connection's two ends. None, with a
   * relation, is the web of that relation across the whole board. */
  roots: string[];
  /** Only claims of this relation (and its aliases): one step from each
   * root, or everywhere when there is no root. */
  relation?: string;
  onShowOnBoard: (imageId: string, rank: number) => void;
  onClose: () => void;
}

export function WebView({
  boardId,
  sort,
  roots: startRoots,
  relation: startRelation,
  onShowOnBoard,
  onClose,
}: Props) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const diagramRef = useRef<WebDiagramHandle | null>(null);
  const [roots, setRoots] = useState(startRoots);
  const [relation, setRelation] = useState(startRelation);
  const [hops, setHops] = useState(startRelation ? 1 : 2);
  const [graph, setGraph] = useState<GetNeighbourhoodResponse | null>(null);
  const [images, setImages] = useState<Map<string, BoardImageWithRank>>(
    new Map(),
  );
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [emphasis, setEmphasis] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const rootKey = roots.join(',');
  useEffect(() => {
    let cancelled = false;
    setError('');
    void (async () => {
      try {
        // No starting pictures: the web of one relation, whole, in one
        // answer. Otherwise each start's neighbourhood, of `relation` if set.
        const parts = rootKey
          ? await Promise.all(
              rootKey
                .split(',')
                .map((r) => api.getNeighbourhood(boardId, r, hops, relation)),
            )
          : relation
            ? [await api.relationWeb(boardId, relation)]
            : [];
        const seen = new Set<string>();
        const edges: EdgeRow[] = [];
        for (const p of parts)
          for (const e of p.edges)
            if (!seen.has(e.id)) {
              seen.add(e.id);
              edges.push(e);
            }
        const ids = [
          ...new Set(parts.flatMap((p) => p.images.map((i) => i.id))),
        ];
        const merged: GetNeighbourhoodResponse = {
          images: ids.map((id) => ({ id, hops: 0 })),
          edges,
          truncated: parts.some((p) => p.truncated),
        };
        const { images: found } = await api.getBoardImagesByIds(
          boardId,
          sort,
          ids,
        );
        if (cancelled) return;
        setGraph(merged);
        setImages(new Map(found.map((img) => [img.id, img])));
      } catch (err) {
        if (!cancelled)
          setError(
            err instanceof Error ? err.message : 'The web could not load.',
          );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [boardId, sort, rootKey, hops, relation]);

  // The web of one relation is laid out around its busiest picture: every
  // picture as a start would put them all on one crowded ring.
  const layoutRoots = useMemo(() => {
    if (!relation || !graph) return rootKey ? rootKey.split(',') : [];
    const degree = new Map<string, number>();
    for (const e of graph.edges)
      for (const id of [e.source.imageId, e.target.imageId])
        degree.set(id, (degree.get(id) ?? 0) + 1);
    const hub = [...degree].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    )[0]?.[0];
    return hub ? [hub] : rootKey ? rootKey.split(',') : [];
  }, [relation, graph, rootKey]);
  const placed = useMemo(
    () =>
      graph
        ? ringLayout(
            layoutRoots,
            graph.images.map((i) => i.id),
            graph.edges,
          )
        : [],
    [graph, layoutRoots],
  );
  const at = useMemo(() => new Map(placed.map((p) => [p.id, p])), [placed]);
  const fit = () => diagramRef.current?.fit();

  const relations = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of graph?.edges ?? [])
      counts.set(e.relation, (counts.get(e.relation) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1]);
  }, [graph]);

  function walkFrom(id: string) {
    // Walking asks what else is around this picture, of any relation.
    setRelation(undefined);
    setRoots([id]);
    setSelected(id);
    setEmphasis(null);
  }

  const pick = selected ? images.get(selected) : undefined;
  const pickPlace = selected ? at.get(selected) : undefined;

  return (
    <dialog
      ref={dialogRef}
      className="web-view"
      data-testid="web-view"
      aria-label="The web of claims"
      onClose={onClose}
      onKeyDown={(e) => {
        if ((e.target as HTMLElement).tagName === 'INPUT') return;
        if (e.key === '1' || e.key === '2' || e.key === '3')
          setHops(Number(e.key));
        if (e.key === '0') fit();
      }}
    >
      <header className="web-view-head">
        <h2>
          {relation
            ? `Every picture "${relation}" joins`
            : `The web around ${roots.map((r) => images.get(r)?.name ?? 'a picture').join(' and ')}`}
        </h2>
        <div className="segmented" role="radiogroup" aria-label="Steps out">
          {[1, 2, 3].map((n) => (
            <label key={n} title={`${n} step${n > 1 ? 's' : ''} out (${n})`}>
              <input
                type="radio"
                name="web-hops"
                checked={hops === n}
                data-testid={`web-hops-${n}`}
                onChange={() => setHops(n)}
              />
              {n} step{n > 1 ? 's' : ''}
            </label>
          ))}
        </div>
        <button type="button" onClick={fit} title="Fit (0)">
          Fit
        </button>
        <button
          type="button"
          className="web-view-close"
          aria-label="Close the web"
          onClick={() => dialogRef.current?.close()}
        >
          <Icon name="close" size={16} />
        </button>
      </header>
      {relations.length > 0 && (
        <div
          className="web-view-relations"
          role="radiogroup"
          aria-label="Emphasise a relation"
        >
          <label>
            <input
              type="radio"
              name="web-relation"
              checked={emphasis === null}
              onChange={() => setEmphasis(null)}
            />
            All
          </label>
          {relations.map(([relation, count]) => (
            <label key={relation || 'unnamed'}>
              <input
                type="radio"
                name="web-relation"
                checked={emphasis === relation}
                onChange={() => setEmphasis(relation)}
              />
              {relation || 'unnamed'} <span>{count}</span>
            </label>
          ))}
        </div>
      )}
      <div className="web-view-body">
        <WebDiagram
          ref={diagramRef}
          edges={graph?.edges ?? []}
          placed={placed}
          roots={layoutRoots}
          srcOf={api.previewUrl}
          nameOf={(id) => images.get(id)?.name ?? 'Picture'}
          selected={selected}
          onSelect={setSelected}
          onWalk={walkFrom}
          emphasis={emphasis}
        />
        {!graph && !error && (
          <p className="web-view-note">Gathering the web…</p>
        )}
        {error && (
          <p className="web-view-note" role="alert">
            {error}
          </p>
        )}
        {graph?.truncated && (
          <p className="web-view-note web-view-note--corner">
            Stopped at 150 pictures around each start.
          </p>
        )}
        {pick && pickPlace && (
          <aside className="web-view-pick" data-testid="web-view-pick">
            <img src={api.previewUrl(pick.id)} alt="" />
            <div>
              <b>{pick.name}</b>
              <span>
                {pickPlace.hops === 0
                  ? 'A starting picture'
                  : `${pickPlace.hops} step${pickPlace.hops === 1 ? '' : 's'} out`}
              </span>
            </div>
            {!roots.includes(pick.id) && (
              <button
                type="button"
                data-testid="web-view-walk"
                onClick={() => walkFrom(pick.id)}
              >
                Walk from here
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                dialogRef.current?.close();
                onShowOnBoard(pick.id, pick.rank ?? -1);
              }}
            >
              Show on board
            </button>
          </aside>
        )}
      </div>
    </dialog>
  );
}
