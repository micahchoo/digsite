// The board's vocabulary as an index of the board (CONTEXT.md "Vocabulary",
// "Alias"): every label and relation the sheets have used, most-used first.
// Pick a term and the map shows the images that carry it. Two spellings of
// one idea are merged here, once, for the whole board; nothing any sheet
// drew is rewritten, and a merge can be undone.
import type { TermKind, VocabularyTerm } from '@digsite/shared';
import { useState } from 'react';
import { Icon } from '../components/Icon.tsx';
import { TermInput } from '../components/TermInput.tsx';
import { plural } from '../lib/plural.ts';
import type { VocabularyApi } from '../lib/vocabulary.ts';

interface Props {
  vocab: VocabularyApi;
  active: { kind: TermKind; term: string } | null;
  onPick: (claim: { kind: TermKind; term: string } | null) => void;
}

const SHOWN = 10;

export function Terms({ vocab, active, onPick }: Props) {
  const [kind, setKind] = useState<TermKind>('label');
  const [all, setAll] = useState(false);
  const [merging, setMerging] = useState<string | null>(null);
  const [into, setInto] = useState('');
  const [error, setError] = useState('');
  const terms =
    kind === 'label' ? vocab.vocabulary.labels : vocab.vocabulary.relations;
  const shown = all ? terms : terms.slice(0, SHOWN);

  async function merge(term: string, canonical: string) {
    setError('');
    try {
      await vocab.merge(kind, term, canonical);
      if (active?.kind === kind && active.term === term)
        onPick({ kind, term: canonical });
      setMerging(null);
      setInto('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not merge');
    }
  }

  return (
    <section className="board-panel-section" data-testid="board-terms">
      <header className="board-panel-heading">
        <h2>Terms</h2>
        <div className="segmented" role="radiogroup" aria-label="Kind of term">
          {(['label', 'relation'] as const).map((k) => (
            <label key={k}>
              <input
                type="radio"
                name="board-terms-kind"
                value={k}
                checked={kind === k}
                onChange={() => {
                  setKind(k);
                  setAll(false);
                  setMerging(null);
                }}
              />
              {k === 'label' ? 'Labels' : 'Relations'}
            </label>
          ))}
        </div>
      </header>

      {terms.length === 0 ? (
        <p className="board-empty-note">
          {kind === 'label'
            ? 'Regions labelled on sheets appear here, and find their images on the map.'
            : 'Connections named on sheets appear here, and find their images on the map.'}
        </p>
      ) : (
        <ul className="board-term-list">
          {shown.map((t) => (
            <TermRow
              key={t.term}
              term={t}
              kind={kind}
              active={active?.kind === kind && active.term === t.term}
              merging={merging === t.term}
              into={into}
              terms={terms.filter((other) => other.term !== t.term)}
              onPick={() =>
                onPick(
                  active?.kind === kind && active.term === t.term
                    ? null
                    : { kind, term: t.term },
                )
              }
              onStartMerge={() => {
                setMerging(merging === t.term ? null : t.term);
                setInto('');
                setError('');
              }}
              onInto={setInto}
              onMerge={(canonical) => void merge(t.term, canonical)}
              onSeparate={(alias) => void vocab.separate(kind, alias)}
            />
          ))}
        </ul>
      )}
      {error && <output className="board-term-error">{error}</output>}
      {terms.length > SHOWN && (
        <button
          type="button"
          className="board-quiet-button board-term-more"
          onClick={() => setAll((v) => !v)}
        >
          {all ? 'Show fewer' : `Show all ${terms.length}`}
        </button>
      )}
    </section>
  );
}

function TermRow({
  term,
  kind,
  active,
  merging,
  into,
  terms,
  onPick,
  onStartMerge,
  onInto,
  onMerge,
  onSeparate,
}: {
  term: VocabularyTerm;
  kind: TermKind;
  active: boolean;
  merging: boolean;
  into: string;
  terms: readonly VocabularyTerm[];
  onPick: () => void;
  onStartMerge: () => void;
  onInto: (v: string) => void;
  onMerge: (canonical: string) => void;
  onSeparate: (alias: string) => void;
}) {
  return (
    <li className="board-term" data-active={active}>
      <div className="board-term-row">
        <button
          type="button"
          className="board-term-pick"
          data-testid={`board-term-${term.term}`}
          aria-pressed={active}
          title={`Show images with this ${kind} on the map`}
          onClick={onPick}
        >
          <span className="board-term-name">{term.term}</span>
          <span className="board-term-count">{term.count}</span>
        </button>
        <button
          type="button"
          className="board-icon-button board-icon-button--small board-term-merge"
          aria-expanded={merging}
          aria-label={`Merge "${term.term}" into another ${kind}`}
          title="Means the same as…"
          onClick={onStartMerge}
        >
          <Icon name="merge" size={14} />
        </button>
      </div>
      {term.aliases.length > 0 && (
        <ul className="board-term-aliases" aria-label="Also written as">
          {term.aliases.map((alias) => (
            <li key={alias}>
              <span>{alias}</span>
              <button
                type="button"
                className="board-term-separate"
                aria-label={`Stop treating "${alias}" as "${term.term}"`}
                title="Separate"
                onClick={() => onSeparate(alias)}
              >
                <Icon name="close" size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {merging && (
        <div className="board-term-merge-form">
          <span className="board-term-merge-lead">
            <b>{term.term}</b> means the same as
          </span>
          <TermInput
            aria-label={`The ${kind} "${term.term}" means the same as`}
            data-testid="board-term-merge-input"
            list="inline"
            value={into}
            terms={terms}
            placeholder={`Another ${kind}…`}
            onChange={onInto}
            onCommit={(v) => {
              if (v.trim()) onMerge(v.trim());
            }}
          />
          <span className="board-term-merge-hint">
            {plural(term.count, 'claim')} will read as the other term. Nothing
            on any sheet is changed.
          </span>
        </div>
      )}
    </li>
  );
}
