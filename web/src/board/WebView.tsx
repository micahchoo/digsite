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
import { NODE, type Placed, ringLayout } from './web-layout.ts';

interface Props {
  boardId: string;
  sort: string;
  /** The starting pictures: one, or a connection's two ends, or every
   * picture a relation joins. */
  roots: string[];
  /** Only claims of this relation (and its aliases), one step from each
   * root: the web of one relation. */
  relation?: string;
  onShowOnBoard: (imageId: string, rank: number) => void;
  onClose: () => void;
}

const THUMB = 72;
const DASH: Record<string, string | undefined> = {
  likely: '9 5',
  unverified: '2 4',
};

type View = { x: number; y: number; scale: number };

/** A line bent a little to one side: two claims on one axis, or a claim
 * passing a picture on its way, stay apart instead of drawn over each
 * other. Returns the path and the point half way along it. */
function bent(
  a: { x: number; y: number },
  b: { x: number; y: number },
  /** Which of the claims on this pair: each bends to its own side. */
  nth = 0,
): { d: string; mid: { x: number; y: number } } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  // A long line passes more pictures on its way, so it bends further.
  const reach = Math.hypot(dx, dy) > 400 ? 0.22 : 0.14;
  const side = nth % 2 === 0 ? 1 : -1;
  const bend = reach * side * (1 + Math.floor(nth / 2) * 0.8);
  const c = { x: (a.x + b.x) / 2 - dy * bend, y: (a.y + b.y) / 2 + dx * bend };
  return {
    d: `M ${a.x} ${a.y} Q ${c.x} ${c.y} ${b.x} ${b.y}`,
    mid: { x: (a.x + 2 * c.x + b.x) / 4, y: (a.y + 2 * c.y + b.y) / 4 },
  };
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
  const svgRef = useRef<SVGSVGElement | null>(null);
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
  const [view, setView] = useState<View>({ x: 0, y: 0, scale: 1 });
  const drag = useRef<{ x: number; y: number } | null>(null);

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
        const parts = await Promise.all(
          rootKey
            .split(',')
            .map((r) => api.getNeighbourhood(boardId, r, hops, relation)),
        );
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
    if (!relation || !graph) return rootKey.split(',');
    const degree = new Map<string, number>();
    for (const e of graph.edges)
      for (const id of [e.source.imageId, e.target.imageId])
        degree.set(id, (degree.get(id) ?? 0) + 1);
    const hub = [...degree].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    )[0]?.[0];
    return hub ? [hub] : rootKey.split(',');
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

  // Fit the whole web when a new one arrives.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new layout is the trigger
  useEffect(() => fit(), [placed]);
  function fit() {
    const svg = svgRef.current;
    if (!svg || !placed.length) return;
    const box = svg.getBoundingClientRect();
    const xs = placed.map((p) => p.x);
    const ys = placed.map((p) => p.y);
    const w = Math.max(...xs) - Math.min(...xs) + NODE * 2;
    const h = Math.max(...ys) - Math.min(...ys) + NODE * 2;
    const scale = Math.min(1.4, box.width / w, box.height / h);
    setView({
      scale,
      x: box.width / 2 - ((Math.max(...xs) + Math.min(...xs)) / 2) * scale,
      y: box.height / 2 - ((Math.max(...ys) + Math.min(...ys)) / 2) * scale,
    });
  }

  // Which claim on its pair each edge is, so two claims on one pair of
  // pictures bend apart and stay readable.
  const pairIndex = useMemo(() => {
    const seen = new Map<string, number>();
    const out = new Map<string, number>();
    for (const e of [...(graph?.edges ?? [])].sort((p, q) =>
      p.id.localeCompare(q.id),
    )) {
      const [x, y] = [e.source.imageId, e.target.imageId].sort();
      const key = `${x}|${y}`;
      const n = seen.get(key) ?? 0;
      seen.set(key, n + 1);
      out.set(e.id, n);
    }
    return out;
  }, [graph]);

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

  const touching = (e: EdgeRow, id: string | null) =>
    id !== null && (e.source.imageId === id || e.target.imageId === id);
  const showLabels = (graph?.edges.length ?? 0) <= 40;
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
        {/* biome-ignore lint/a11y/noSvgWithoutTitle: labelled by its dialog; each picture is a labelled button */}
        <svg
          ref={svgRef}
          className="web-view-canvas"
          data-testid="web-view-canvas"
          onWheel={(e) => {
            const box = e.currentTarget.getBoundingClientRect();
            const px = e.clientX - box.left;
            const py = e.clientY - box.top;
            const factor = Math.exp(-e.deltaY * 0.0015);
            setView((v) => {
              const scale = Math.min(4, Math.max(0.1, v.scale * factor));
              const k = scale / v.scale;
              return { scale, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
            });
          }}
          onPointerDown={(e) => {
            if (e.button !== 0 || e.target !== e.currentTarget) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { x: e.clientX, y: e.clientY };
            setSelected(null);
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d) return;
            drag.current = { x: e.clientX, y: e.clientY };
            setView((v) => ({
              ...v,
              x: v.x + e.clientX - d.x,
              y: v.y + e.clientY - d.y,
            }));
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
        >
          <defs>
            <clipPath id="web-thumb">
              <rect
                x={-THUMB / 2}
                y={-THUMB / 2}
                width={THUMB}
                height={THUMB}
                rx={8}
              />
            </clipPath>
          </defs>
          <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
            {graph?.edges.map((edge) => {
              const a = at.get(edge.source.imageId);
              const b = at.get(edge.target.imageId);
              if (!a || !b) return null;
              const lit =
                (emphasis === null || edge.relation === emphasis) &&
                (selected === null || touching(edge, selected));
              return (
                <g
                  key={edge.id}
                  className="web-view-edge"
                  data-testid="web-view-edge"
                  opacity={lit ? 1 : 0.18}
                >
                  <path
                    d={bent(a, b, pairIndex.get(edge.id)).d}
                    strokeDasharray={
                      edge.confidence ? DASH[edge.confidence] : undefined
                    }
                  />
                  {(showLabels || touching(edge, selected)) &&
                    lit &&
                    (() => {
                      const { mid } = bent(a, b, pairIndex.get(edge.id));
                      const text = edge.relation || 'unnamed';
                      // A solid chip: a halo around the glyphs alone lets
                      // the line show through the space between words.
                      const width = text.length * 6.6 + 12;
                      return (
                        <>
                          <rect
                            x={mid.x - width / 2}
                            y={mid.y - 9}
                            width={width}
                            height={18}
                            rx={9}
                          />
                          <text x={mid.x} y={mid.y}>
                            {text}
                          </text>
                        </>
                      );
                    })()}
                </g>
              );
            })}
            {placed.map((p: Placed) => {
              const img = images.get(p.id);
              const isRoot = layoutRoots.includes(p.id);
              return (
                <g
                  key={p.id}
                  // biome-ignore lint/a11y/useSemanticElements: an SVG group cannot be a <button>; it takes the role and the keys
                  role="button"
                  tabIndex={0}
                  aria-label={`${img?.name ?? 'Picture'}, ${p.hops} step${p.hops === 1 ? '' : 's'} out`}
                  className={`web-view-node${isRoot ? ' is-root' : ''}${selected === p.id ? ' is-selected' : ''}`}
                  data-testid="web-view-node"
                  data-image-id={p.id}
                  transform={`translate(${p.x} ${p.y})`}
                  onClick={() => setSelected(p.id)}
                  onDoubleClick={() => walkFrom(p.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') walkFrom(p.id);
                    if (e.key === ' ') {
                      e.preventDefault();
                      setSelected(p.id);
                    }
                  }}
                >
                  <rect
                    x={-THUMB / 2 - 3}
                    y={-THUMB / 2 - 3}
                    width={THUMB + 6}
                    height={THUMB + 6}
                    rx={10}
                  />
                  <image
                    href={api.previewUrl(p.id)}
                    x={-THUMB / 2}
                    y={-THUMB / 2}
                    width={THUMB}
                    height={THUMB}
                    preserveAspectRatio="xMidYMid slice"
                    clipPath="url(#web-thumb)"
                  />
                  {view.scale > 0.55 && (
                    <text y={THUMB / 2 + 16}>{img?.name ?? ''}</text>
                  )}
                </g>
              );
            })}
          </g>
        </svg>
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
