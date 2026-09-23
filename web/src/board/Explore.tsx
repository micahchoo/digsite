// Sheet from a neighbourhood (docs/phases/2-sheet.md section 4). Lives
// beside Board.tsx's Detail panel, not inside board/Detail.tsx — Detail
// edits an image row and is shared with sheet/Inspector.tsx, which has no
// board-scoped "new sheet" of its own; this owns only board-scoped state.
//
// Flow: pick hops (1-3) and an optional relation, "Explore" fetches the
// neighbourhood and hands the image ids to `onSelectImages` (Board.tsx's
// `selectImagesById`, also `window.__digsiteBoard.selectImages`) so the
// result becomes the map selection. "New sheet" lays the result out with
// `ringLayout` (shared/sheet/layout.ts) and sends the centres as
// `CreateSheetRequest.positions` — `server/src/sheets/routes.ts` (and the
// stub, matching it) converts a centre to a top-left itself
// (../board/explore-layout.ts mirrors that arithmetic for the stub and for
// this file's own test). "copy connections" ticked carries the
// neighbourhood's own-image-to-own-image edges through `navigate(...,
// {state})` for Sheet.tsx to apply once the new sheet has loaded.
import type { EdgeRow, GetNeighbourhoodResponse } from '@digsite/shared';
import { ringLayout } from '@digsite/shared';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { ApiError, api } from '../lib/api.ts';
import { plural } from '../lib/plural.ts';
import type { PendingCopyEdge } from '../sheet/Sheet.tsx';

interface Props {
  boardId: string;
  imageId: string;
  /** The board's current selection size, read at the moment "Explore" is
   * clicked — docs/ux/audit.md #6: "Explore from here" used to overwrite
   * this silently, with zero warning, even when the anchor image had no
   * connections and the neighbourhood collapsed to 1. Zero means there is
   * nothing to lose, so the result becomes the selection immediately with
   * no prompt. */
  currentSelectionCount: number;
  onSelectImages: (ids: string[], mode?: 'replace' | 'add') => void;
}

const HOPS_OPTIONS = [1, 2, 3] as const;

function copyableEdges(edges: EdgeRow[]): PendingCopyEdge[] {
  // Only a plain image-to-image edge can become an own edge on the new
  // sheet — an end bound to a REGION has nothing on the new sheet to bind
  // to (no such region exists there), same restriction as
  // sheet/tools.ts#copyForeign.
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
}: Props) {
  const navigate = useNavigate();
  const [hops, setHops] = useState<1 | 2 | 3>(1);
  const [relation, setRelation] = useState('');
  const [relations, setRelations] = useState<string[]>([]);
  const [result, setResult] = useState<GetNeighbourhoodResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sheetName, setSheetName] = useState('');
  const [copyConnections, setCopyConnections] = useState(false);
  const [creating, setCreating] = useState(false);
  // Holds the neighbourhood's image ids while the owner is asked what to do
  // with the existing selection; null means no prompt is showing.
  const [pendingSelection, setPendingSelection] = useState<string[] | null>(
    null,
  );

  // A best-effort relation list, from a real `GET /boards/:id/relations` if
  // it exists — see lib/api.ts's header comment. Not fatal when it 404s;
  // the relation dropdown just starts empty until the first Explore fills
  // it from that response's own edges.
  useEffect(() => {
    let cancelled = false;
    setRelations([]);
    void api
      .getBoardRelations(boardId)
      .then((r) => {
        if (!cancelled) setRelations(r);
      })
      .catch(() => {
        // route not on this server yet; derived from the neighbourhood below
      });
    return () => {
      cancelled = true;
    };
  }, [boardId]);

  async function explore() {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getNeighbourhood(
        boardId,
        imageId,
        hops,
        relation || undefined,
      );
      setResult(res);
      const found = Array.from(
        new Set(res.edges.map((e) => e.relation)),
      ).filter(Boolean);
      setRelations((prev) => Array.from(new Set([...prev, ...found])));
      const ids = res.images.map((i) => i.id);
      if (currentSelectionCount > 0) {
        setPendingSelection(ids);
      } else {
        onSelectImages(ids, 'replace');
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.reason : String(err));
    } finally {
      setLoading(false);
    }
  }

  function resolvePendingSelection(mode: 'replace' | 'add') {
    if (!pendingSelection) return;
    onSelectImages(pendingSelection, mode);
    setPendingSelection(null);
  }

  async function newSheet(e: React.FormEvent) {
    e.preventDefault();
    if (!result || !sheetName.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const positions = Object.fromEntries(ringLayout(result.images).entries());
      const { id: newId } = await api.createSheet(boardId, {
        name: sheetName.trim(),
        imageIds: result.images.map((i) => i.id),
        positions,
      });
      if (copyConnections) {
        const copyEdges = copyableEdges(result.edges);
        navigate(`/s/${newId}`, { state: { copyEdges } });
      } else {
        navigate(`/s/${newId}`);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.reason : String(err));
      setCreating(false);
    }
  }

  return (
    <section className="board-explore" data-testid="explore-panel">
      <div className="board-detail-section-title">
        <span className="board-eyebrow">RELATIONSHIP MAP</span>
        <h3>Explore from here</h3>
      </div>
      {error && <div className="error">{error}</div>}
      {pendingSelection && (
        <div
          className="card"
          data-testid="explore-selection-confirm"
          style={{
            borderColor: '#e8590c',
            background: '#fff9db',
            marginTop: 6,
          }}
        >
          <div>
            Replace your {plural(currentSelectionCount, 'selected image')} with
            this neighbourhood?
          </div>
          <div className="row" style={{ marginTop: 6 }}>
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
      <div className="board-explore-controls">
        <label>
          <span>Hops</span>{' '}
          <select
            data-testid="explore-hops"
            value={hops}
            onChange={(e) => setHops(Number(e.target.value) as 1 | 2 | 3)}
          >
            {HOPS_OPTIONS.map((h) => (
              <option key={h} value={h}>
                {h}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Relation</span>{' '}
          <select
            data-testid="explore-relation"
            value={relation}
            onChange={(e) => setRelation(e.target.value)}
          >
            <option value="">any</option>
            {relations.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          data-testid="explore-go"
          disabled={loading}
          onClick={() => void explore()}
        >
          {loading ? 'Exploring…' : 'Explore'}
        </button>
      </div>
      {result && (
        <div data-testid="explore-result" style={{ marginTop: 6 }}>
          <span className="muted">
            {plural(result.images.length, 'image')}
            {result.truncated ? ' (capped)' : ''} ·{' '}
            {plural(result.edges.length, 'edge')}
          </span>
          <form
            className="board-explore-sheet-form"
            onSubmit={(e) => void newSheet(e)}
          >
            <input
              data-testid="explore-sheet-name"
              aria-label="New sheet name"
              placeholder="new sheet name"
              value={sheetName}
              onChange={(e) => setSheetName(e.target.value)}
            />
            <label className="row" style={{ margin: '4px 0' }}>
              <input
                type="checkbox"
                data-testid="explore-copy-connections"
                checked={copyConnections}
                onChange={(e) => setCopyConnections(e.target.checked)}
              />
              Copy connections to sheet
            </label>
            <button
              type="submit"
              data-testid="explore-new-sheet"
              disabled={!sheetName.trim() || creating}
            >
              Create sheet
            </button>
          </form>
        </div>
      )}
    </section>
  );
}
