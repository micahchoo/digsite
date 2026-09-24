// The board's web (CONTEXT.md "Web"): the other way to look at a board.
// The map lays pictures out by a sort; the web lays them out by their
// claims, every sheet's, on hop rings (web-layout.ts) around the pictures
// its question starts from, or around the busiest ones when it starts from
// none. image-graph's exploration, over the board's union of claims.
//
// It answers one question (web-question.ts), which lives in the board's
// URL: this page never keeps its own. Walking from a picture, or asking
// fewer steps, is a new question the board puts in the URL. And it has
// three ways out, each keeping what is shown: a sheet of these pictures
// where the web has them, a report of these claims, or these pictures
// selected on the map.
import type {
  BoardImageWithRank,
  EdgeRow,
  GetNeighbourhoodResponse,
} from '@digsite/shared';
import { SHEET_LIMIT } from '@digsite/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../components/Icon.tsx';
import { api } from '../lib/api.ts';
import { modalOpen } from '../lib/modal.ts';
import { WebDiagram, type WebDiagramHandle } from './WebDiagram.tsx';
import { type Placed, ringLayout } from './web-layout.ts';
import {
  type Hops,
  type WebQuestion,
  webQuestion,
  webTitle,
} from './web-question.ts';

/** About the panel's shape, so a web of many parts fills it in rows. */
const FRAME_ASPECT = 16 / 10;

interface Props {
  boardId: string;
  sort: string;
  question: WebQuestion;
  /** A new question: a walk, another number of steps. */
  onAsk: (q: WebQuestion) => void;
  /** Back to the map. */
  onClose: () => void;
  /** A new sheet of these pictures, placed as the web has them. */
  onMakeSheet: (placed: readonly Placed[], title: string) => void;
  /** A report of what the web shows. */
  onReport: () => void;
  /** These pictures, selected on the map. */
  onSelectOnMap: (imageIds: string[]) => void;
  onShowOnBoard: (imageId: string, rank: number) => void;
}

export function WebView({
  boardId,
  sort,
  question,
  onAsk,
  onClose,
  onMakeSheet,
  onReport,
  onSelectOnMap,
  onShowOnBoard,
}: Props) {
  const diagramRef = useRef<WebDiagramHandle | null>(null);
  const { roots, hops, relation } = question;
  const [graph, setGraph] = useState<GetNeighbourhoodResponse | null>(null);
  const [images, setImages] = useState<Map<string, BoardImageWithRank>>(
    new Map(),
  );
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [emphasis, setEmphasis] = useState<string | null>(null);

  // Esc goes back to the map from wherever focus is (the button that
  // opened the web keeps it), unless a dialog or a field has it first.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (e.key !== 'Escape' || e.defaultPrevented || modalOpen()) return;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      closeRef.current();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const rootKey = roots.join(',');
  useEffect(() => {
    let cancelled = false;
    setError('');
    setGraph(null);
    void (async () => {
      try {
        // No start pictures: the board's whole web, or one relation's, in
        // one answer. Otherwise each start's neighbourhood.
        const parts = rootKey
          ? await Promise.all(
              rootKey
                .split(',')
                .map((r) =>
                  api.getNeighbourhood(boardId, r, hops, relation ?? undefined),
                ),
            )
          : [await api.relationWeb(boardId, relation ?? '')];
        const seen = new Set<string>();
        const edges: EdgeRow[] = [];
        for (const p of parts)
          for (const e of p.edges)
            if (!seen.has(e.id)) {
              seen.add(e.id);
              edges.push(e);
            }
        const ids = [
          ...new Set([
            ...(rootKey ? rootKey.split(',') : []),
            ...parts.flatMap((p) => p.images.map((i) => i.id)),
          ]),
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

  // With no start pictures, each part of the web sits around its own
  // busiest picture (ringLayout); starting from all of them would put them
  // on one crowded ring.
  const layoutRoots = useMemo(
    () => (rootKey ? rootKey.split(',') : []),
    [rootKey],
  );
  const placed = useMemo(
    () =>
      graph
        ? ringLayout(
            layoutRoots,
            graph.images.map((i) => i.id),
            graph.edges,
            FRAME_ASPECT,
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

  /** Walking asks what else is around this picture, of any relation. */
  function walkFrom(id: string) {
    setSelected(id);
    setEmphasis(null);
    onAsk(webQuestion([id], { hops }));
  }

  const title = webTitle(question, (id) => images.get(id)?.name);
  const pick = selected ? images.get(selected) : undefined;
  const pickPlace = selected ? at.get(selected) : undefined;
  const count = placed.length;

  return (
    <section
      className="web-view"
      data-testid="web-view"
      aria-label={title}
      onKeyDown={(e) => {
        if ((e.target as HTMLElement).tagName === 'INPUT') return;
        if (e.key === '1' || e.key === '2' || e.key === '3')
          onAsk({ ...question, hops: Number(e.key) as Hops });
        if (e.key === '0') fit();
      }}
    >
      <header className="web-view-head">
        <h2 data-testid="web-view-title">{title}</h2>
        {roots.length > 0 && (
          <div className="segmented" role="radiogroup" aria-label="Steps out">
            {([1, 2, 3] as const).map((n) => (
              <label key={n} title={`${n} step${n > 1 ? 's' : ''} out (${n})`}>
                <input
                  type="radio"
                  name="web-hops"
                  checked={hops === n}
                  data-testid={`web-hops-${n}`}
                  onChange={() => onAsk({ ...question, hops: n })}
                />
                {n} step{n > 1 ? 's' : ''}
              </label>
            ))}
          </div>
        )}
        <button type="button" onClick={fit} title="Fit every picture (0)">
          <Icon name="fit" size={16} />
          Fit
        </button>
        <button
          type="button"
          className="web-view-close"
          aria-label="Back to the map"
          title="Back to the map (Esc)"
          data-testid="web-view-close"
          onClick={onClose}
        >
          <Icon name="close" size={16} />
        </button>
      </header>
      <div className="web-view-outs" role="group" aria-label="Take this web">
        <button
          type="button"
          data-testid="web-make-sheet"
          disabled={!count}
          title={
            count > SHEET_LIMIT
              ? `A sheet holds ${SHEET_LIMIT} pictures: the nearest ${SHEET_LIMIT}`
              : 'A new sheet of these pictures, placed as the web has them'
          }
          onClick={() => onMakeSheet(placed, title)}
        >
          <Icon name="sheet" size={16} />
          Make a sheet
        </button>
        <button
          type="button"
          data-testid="web-report"
          disabled={!graph?.edges.length}
          title="A report of every claim this web shows"
          onClick={onReport}
        >
          <Icon name="report" size={16} />
          Report on this
        </button>
        <button
          type="button"
          data-testid="web-select-on-map"
          disabled={!count}
          title="Select these pictures on the map"
          onClick={() => onSelectOnMap(placed.map((p) => p.id))}
        >
          <Icon name="cursor" size={16} />
          Select on map
        </button>
      </div>
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
          {relations.map(([rel, n]) => (
            <label key={rel || 'unnamed'}>
              <input
                type="radio"
                name="web-relation"
                checked={emphasis === rel}
                onChange={() => setEmphasis(rel)}
              />
              {rel || 'unnamed'} <span>{n}</span>
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
        {graph && !graph.edges.length && (
          <p className="web-view-note" data-testid="web-view-empty">
            {roots.length
              ? 'No sheet connects these pictures yet.'
              : 'No sheet on this board has made a connection yet.'}
          </p>
        )}
        {error && (
          <p className="web-view-note" role="alert">
            {error}
          </p>
        )}
        {graph?.truncated && (
          <p className="web-view-note web-view-note--corner">
            Stopped at {SHEET_LIMIT} pictures
            {roots.length ? ' around each start' : ', the most connected'}.
          </p>
        )}
        {pick && pickPlace && (
          <aside className="web-view-pick" data-testid="web-view-pick">
            <img src={api.previewUrl(pick.id)} alt="" />
            <div>
              <b>{pick.name}</b>
              <span>
                {roots.includes(pick.id)
                  ? 'A starting picture'
                  : roots.length
                    ? `${pickPlace.hops} step${pickPlace.hops === 1 ? '' : 's'} out`
                    : 'On the board’s web'}
              </span>
            </div>
            {!(roots.length === 1 && roots[0] === pick.id) && (
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
              onClick={() => onShowOnBoard(pick.id, pick.rank ?? -1)}
            >
              Show on the map
            </button>
          </aside>
        )}
      </div>
    </section>
  );
}
