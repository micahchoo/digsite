// An image's connections, shown the moment it is focused (CONTEXT.md "The
// union": every sheet's edges, walked across sheets). No form to fill
// first: the 1-hop neighbourhood is already there, as a count, the
// relations that make it, and the images themselves. Widen the depth, pick
// a relation to narrow it, click a neighbour to walk to it. The board draws
// the same connections between the cells (Board.tsx, `onGraph`).
//
// Selecting the neighbourhood asks before replacing an existing selection
// (docs/ux/audit.md #6). A sheet made from it is laid out with
// `ringLayout` (shared/sheet/layout.ts), centres sent as
// `CreateSheetRequest.positions`; "copy connections" carries the
// neighbourhood's image-to-image edges to the new sheet through
// `navigate(..., {state})`.
import type { EdgeRow, GetNeighbourhoodResponse } from '@digsite/shared';
import { ringLayout } from '@digsite/shared';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { ApiError, api } from '../lib/api.ts';
import { plural } from '../lib/plural.ts';
import type { PendingCopyEdge } from '../sheet/Sheet.tsx';

interface Props {
  boardId: string;
  imageId: string;
  /** The board's current selection size: zero means nothing to lose, so
   * the neighbourhood becomes the selection without asking. */
  currentSelectionCount: number;
  onSelectImages: (ids: string[], mode?: 'replace' | 'add') => void;
  /** The neighbourhood on screen, for the map to draw; null when none. */
  onGraph: (graph: GetNeighbourhoodResponse | null) => void;
  /** Walks to a neighbour: it becomes the focused image. */
  onVisit: (imageId: string) => void;
}

const HOPS = [1, 2, 3] as const;
type Hops = (typeof HOPS)[number];
/** Neighbours shown as thumbnails; the rest are counted. */
const SHOWN = 12;

function copyableEdges(edges: EdgeRow[]): PendingCopyEdge[] {
  // Only a plain image-to-image edge can become an own edge on the new
  // sheet: an end bound to a region has nothing there to bind to, the same
  // restriction as sheet/tools.ts#copyForeign.
  return edges
    .filter((e) => !e.source.regionSourceId && !e.target.regionSourceId)
    .map((e) => ({
      sourceImageId: e.source.imageId,
      targetImageId: e.target.imageId,
      relation: e.relation,
      direction: e.direction,
    }));
}

export function Explore({
  boardId,
  imageId,
  currentSelectionCount,
  onSelectImages,
  onGraph,
  onVisit,
}: Props) {
  const navigate = useNavigate();
  const [hops, setHops] = useState<Hops>(1);
  const [relation, setRelation] = useState('');
  const [result, setResult] = useState<GetNeighbourhoodResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sheetName, setSheetName] = useState('');
  const [copyConnections, setCopyConnections] = useState(false);
  const [creating, setCreating] = useState(false);
  const [pendingSelection, setPendingSelection] = useState<string[] | null>(
    null,
  );
  /** The request for the question on screen now, so an action taken right
   * after the depth changes acts on the answer to the new question. */
  const current = useRef<Promise<GetNeighbourhoodResponse | null> | null>(null);
  const onGraphRef = useRef(onGraph);
  onGraphRef.current = onGraph;

  // A different image starts from its nearest neighbours again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: imageId is the trigger
  useEffect(() => {
    setHops(1);
    setRelation('');
    setPendingSelection(null);
  }, [imageId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const request = api
      .getNeighbourhood(boardId, imageId, hops, relation || undefined)
      .then((res) => {
        if (!cancelled) {
          setResult(res);
          onGraphRef.current(res.edges.length ? res : null);
        }
        return res;
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.reason : String(err));
          setResult(null);
          onGraphRef.current(null);
        }
        return null;
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    current.current = request;
    return () => {
      cancelled = true;
    };
  }, [boardId, imageId, hops, relation]);

  useEffect(() => () => onGraphRef.current(null), []);

  async function selectThese() {
    const res = await current.current;
    if (!res) return;
    const ids = res.images.map((i) => i.id);
    if (currentSelectionCount > 0) setPendingSelection(ids);
    else onSelectImages(ids, 'replace');
  }

  function resolvePendingSelection(mode: 'replace' | 'add') {
    if (!pendingSelection) return;
    onSelectImages(pendingSelection, mode);
    setPendingSelection(null);
  }

  async function newSheet(e: React.FormEvent) {
    e.preventDefault();
    const res = await current.current;
    if (!res || !sheetName.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const positions = Object.fromEntries(ringLayout(res.images).entries());
      const { id: newId } = await api.createSheet(boardId, {
        name: sheetName.trim(),
        imageIds: res.images.map((i) => i.id),
        positions,
      });
      if (copyConnections) {
        navigate(`/s/${newId}`, {
          state: { copyEdges: copyableEdges(res.edges) },
        });
      } else {
        navigate(`/s/${newId}`);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.reason : String(err));
      setCreating(false);
    }
  }

  const neighbours = (result?.images ?? []).filter((i) => i.id !== imageId);
  const relationCounts = new Map<string, number>();
  for (const e of result?.edges ?? []) {
    const key = e.relation || '';
    relationCounts.set(key, (relationCounts.get(key) ?? 0) + 1);
  }
  const chips = [...relationCounts].sort((a, b) => b[1] - a[1]);

  return (
    <section className="board-panel-section" data-testid="explore-panel">
      <div className="board-panel-heading">
        <h3>Connections</h3>
        <div
          className="segmented"
          role="radiogroup"
          aria-label="How far to look"
          data-testid="explore-hops"
        >
          {HOPS.map((h) => (
            <label
              key={h}
              title={h === 1 ? 'Direct connections' : `${h} steps away`}
            >
              <input
                type="radio"
                name="explore-hops"
                value={h}
                checked={hops === h}
                data-testid={`explore-hops-${h}`}
                onChange={() => setHops(h)}
              />
              {h === 1 ? '1 hop' : `${h}`}
            </label>
          ))}
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      {result && neighbours.length === 0 && !relation ? (
        <p className="board-empty-note">
          Nothing connects to this image yet. Connect it to another image on a
          sheet and the connection shows here.
        </p>
      ) : (
        result && (
          <div
            data-testid="explore-result"
            className="board-explore-result"
            aria-busy={loading}
          >
            <span className="board-image-facts">
              Found {plural(result.images.length, 'image')}
              {result.truncated ? ' (capped)' : ''} and{' '}
              {plural(result.edges.length, 'edge')}
            </span>
            {(chips.length > 1 || relation) && (
              <div
                className="board-explore-chips"
                aria-label="Narrow by relation"
              >
                {relation ? (
                  <button
                    type="button"
                    className="board-explore-chip"
                    aria-pressed="true"
                    data-testid="explore-relation"
                    onClick={() => setRelation('')}
                  >
                    {relation}
                    <span className="board-explore-chip-clear">
                      All relations
                    </span>
                  </button>
                ) : (
                  chips.map(([r, n]) => (
                    <button
                      key={r || 'unnamed'}
                      type="button"
                      className="board-explore-chip"
                      aria-pressed="false"
                      disabled={!r}
                      onClick={() => setRelation(r)}
                    >
                      {r || 'Unnamed'}
                      <span className="board-explore-chip-count">{n}</span>
                    </button>
                  ))
                )}
              </div>
            )}
            {neighbours.length > 0 && (
              <ul
                className="board-explore-neighbours"
                aria-label="Connected images"
              >
                {neighbours.slice(0, SHOWN).map((n) => (
                  <li key={n.id}>
                    <button
                      type="button"
                      className="board-explore-neighbour"
                      title={`Go to this image (${plural(n.hops, 'hop')} away)`}
                      aria-label={`Go to connected image, ${plural(n.hops, 'hop')} away`}
                      onClick={() => onVisit(n.id)}
                    >
                      <img src={api.previewUrl(n.id)} alt="" loading="lazy" />
                      {n.hops > 1 && (
                        <span className="board-explore-hops-badge">
                          {n.hops}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
                {neighbours.length > SHOWN && (
                  <li className="board-explore-more">
                    +{neighbours.length - SHOWN}
                  </li>
                )}
              </ul>
            )}
            <div className="board-explore-actions">
              <button
                type="button"
                data-testid="explore-go"
                disabled={!result.images.length}
                onClick={() => void selectThese()}
              >
                Select{' '}
                {result.images.length === 1
                  ? 'it'
                  : `these ${result.images.length}`}
              </button>
            </div>
            {pendingSelection && (
              <div
                className="board-callout"
                data-testid="explore-selection-confirm"
              >
                <p>
                  Replace your {plural(currentSelectionCount, 'selected image')}{' '}
                  with these?
                </p>
                <div className="board-callout-actions">
                  <button
                    type="button"
                    data-testid="explore-selection-replace"
                    onClick={() => resolvePendingSelection('replace')}
                  >
                    Replace
                  </button>
                  <button
                    type="button"
                    data-testid="explore-selection-add"
                    onClick={() => resolvePendingSelection('add')}
                  >
                    Add to selection
                  </button>
                  <button
                    type="button"
                    data-testid="explore-selection-cancel"
                    onClick={() => setPendingSelection(null)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {result.images.length > 1 && (
              <form
                className="board-explore-sheet-form"
                onSubmit={(e) => void newSheet(e)}
              >
                <label
                  className="board-explore-sheet-label"
                  htmlFor="explore-sheet-name"
                >
                  Start a sheet from these
                </label>
                <div className="board-explore-sheet-row">
                  <input
                    id="explore-sheet-name"
                    data-testid="explore-sheet-name"
                    placeholder="Name it…"
                    value={sheetName}
                    onChange={(e) => setSheetName(e.target.value)}
                  />
                  <button
                    type="submit"
                    className="board-primary-button"
                    data-testid="explore-new-sheet"
                    disabled={!sheetName.trim() || creating}
                  >
                    Create
                  </button>
                </div>
                <label className="board-check">
                  <input
                    type="checkbox"
                    data-testid="explore-copy-connections"
                    checked={copyConnections}
                    onChange={(e) => setCopyConnections(e.target.checked)}
                  />
                  Bring the connections too
                </label>
              </form>
            )}
          </div>
        )
      )}
    </section>
  );
}
