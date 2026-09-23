// The machine suggests; a person decides (docs/roadmap.md, horizon 4).
// Under a picture on a sheet: the board's pictures that look like it, by
// what is in them (the server's embeddings), best first. Nothing reaches
// the sheet until someone chooses it, and nothing is connected until
// someone says how: Bring here puts it beside this picture, and only then
// is a connection offered: "copy of" for a near-duplicate (CONTEXT.md),
// "resembles" for the rest.
import { useEffect, useState } from 'react';
import { ApiError, api } from '../lib/api.ts';

const SHOWN = 6;

interface Props {
  boardId: string;
  sort: string;
  imageId: string;
  /** Pictures already on this sheet: not worth suggesting. */
  onSheet: ReadonlySet<string>;
  /** Adds the picture beside this one; its element id, or null. */
  onBring: (imageId: string) => Promise<string | null>;
  /** Connects two elements with a relation the person chose. */
  onConnect: (elementId: string, relation: string) => void;
}

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; ids: string[] }
  | { kind: 'unread' }
  | { kind: 'off' }
  | { kind: 'failed'; message: string };

export function LooksLike({
  boardId,
  sort,
  imageId,
  onSheet,
  onBring,
  onConnect,
}: Props) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  /** Brought here from this list: picture id -> its new element id. */
  const [brought, setBrought] = useState<Map<string, string>>(new Map());
  const [connected, setConnected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  /** Near-duplicates among the suggestions: offered as "copy of". */
  const [copies, setCopies] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    setBrought(new Map());
    setConnected(new Set());
    setCopies(new Set());
    api
      .nearDuplicates(boardId, sort, imageId)
      .then(({ matches }) => {
        if (!cancelled) setCopies(new Set(matches.map((m) => m.imageId)));
      })
      .catch(() => {});
    api
      .similarImages(boardId, sort, imageId, 40)
      .then(({ matches }) => {
        if (!cancelled)
          setState({ kind: 'ready', ids: matches.map((m) => m.imageId) });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 503)
          setState({ kind: 'off' });
        else if (err instanceof ApiError && err.status === 409)
          setState({ kind: 'unread' });
        else
          setState({
            kind: 'failed',
            message: err instanceof Error ? err.message : 'No suggestions.',
          });
      });
    return () => {
      cancelled = true;
    };
  }, [boardId, sort, imageId]);

  // Off on this server: say nothing at all rather than offer a dead end.
  if (state.kind === 'off') return null;

  const suggestions =
    state.kind === 'ready'
      ? state.ids
          .filter(
            (id) => id !== imageId && (!onSheet.has(id) || brought.has(id)),
          )
          .slice(0, SHOWN)
      : [];

  return (
    <section className="claim-section looks-like" data-testid="looks-like">
      <h3>Looks like</h3>
      <p className="claim-hint">
        Other pictures on the board, by what is in them. Nothing is added until
        you choose.
      </p>
      {state.kind === 'loading' && <p className="claim-hint">Looking…</p>}
      {state.kind === 'unread' && (
        <p className="claim-hint">
          This picture has not been read yet. Try again in a minute.
        </p>
      )}
      {state.kind === 'failed' && (
        <p className="claim-hint" role="alert">
          {state.message}
        </p>
      )}
      {state.kind === 'ready' && suggestions.length === 0 && (
        <p className="claim-hint">Every picture like it is on this sheet.</p>
      )}
      {suggestions.length > 0 && (
        <ul className="looks-like-list">
          {suggestions.map((id) => {
            const element = brought.get(id);
            return (
              <li
                key={id}
                data-testid="looks-like-item"
                data-copy={copies.has(id) || undefined}
              >
                <img src={api.previewUrl(id)} alt="" loading="lazy" />
                {copies.has(id) && (
                  <span className="looks-like-copy">Nearly the same</span>
                )}
                {!element ? (
                  <button
                    type="button"
                    data-testid="looks-like-bring"
                    disabled={busy !== null}
                    onClick={async () => {
                      setBusy(id);
                      try {
                        const added = await onBring(id);
                        if (added) setBrought((m) => new Map(m).set(id, added));
                      } finally {
                        // Never left saying "Bringing…" after a failure.
                        setBusy(null);
                      }
                    }}
                  >
                    {busy === id ? 'Bringing…' : 'Bring here'}
                  </button>
                ) : connected.has(id) ? (
                  <span className="looks-like-done">Connected</span>
                ) : (
                  <button
                    type="button"
                    data-testid="looks-like-connect"
                    onClick={() => {
                      onConnect(
                        element,
                        copies.has(id) ? 'copy of' : 'resembles',
                      );
                      setConnected((set) => new Set(set).add(id));
                    }}
                  >
                    {copies.has(id) ? 'Connect: copy of' : 'Connect: resembles'}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
