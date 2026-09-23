// The board's Find panel: it shows a question (find.ts) and its answer, and
// every change a person makes is one action on the question. The property
// filter being typed is the panel's own until it is added.
import type { FindFilterClause, SortableKey } from '@digsite/shared';
import { useState } from 'react';
import { Icon } from '../components/Icon.tsx';
import { api } from '../lib/api.ts';
import {
  type FindAction,
  type FindQuestion,
  type FindResult,
  MEANING_STRIP,
  isSet,
  parseFilter,
} from './find.ts';

export function FindPanel({
  question,
  dispatch,
  result,
  error,
  sortableKeys,
  onSelectAll,
  onShowOnMap,
}: {
  question: FindQuestion;
  dispatch: (a: FindAction) => void;
  result: FindResult | null;
  error: string;
  sortableKeys: SortableKey[];
  onSelectAll: () => void;
  onShowOnMap: (imageId: string, rank: number) => void;
}) {
  const [filterKey, setFilterKey] = useState('');
  const [filterOp, setFilterOp] = useState<FindFilterClause['op']>('eq');
  const [filterValue, setFilterValue] = useState('');
  const { mode, like, claim, filters } = question;

  function addFilter() {
    const clause = parseFilter(sortableKeys, filterKey, filterOp, filterValue);
    if (!clause) return;
    dispatch({ type: 'filter', clause });
    setFilterValue('');
  }

  return (
    <div className="board-find" data-testid="board-find">
      <div className="row">
        <div
          className="segmented"
          role="radiogroup"
          aria-label="Search by"
          data-testid="board-find-mode"
        >
          {(
            [
              ['words', 'Words', 'Names and properties'],
              ['meaning', 'Meaning', 'What is in the picture'],
            ] as const
          ).map(([m, label, title]) => (
            <label key={m} title={title}>
              <input
                type="radio"
                name="board-find-mode"
                value={m}
                checked={mode === m && !like}
                data-testid={`board-find-mode-${m}`}
                onChange={() => dispatch({ type: 'mode', mode: m })}
              />
              {label}
            </label>
          ))}
        </div>
        <input
          aria-label={
            mode === 'meaning'
              ? 'Describe what is in the picture'
              : 'Search image names and properties'
          }
          data-testid="board-find-query"
          placeholder={
            mode === 'meaning'
              ? 'Describe what is in the picture'
              : 'Search names and properties'
          }
          value={question.text}
          onChange={(e) => dispatch({ type: 'text', text: e.target.value })}
        />
        {mode === 'words' && !like && (
          <>
            <select
              aria-label="Property to filter"
              data-testid="board-filter-key"
              value={filterKey}
              onChange={(e) => setFilterKey(e.target.value)}
            >
              <option value="">Property…</option>
              {sortableKeys.flatMap((item) =>
                typeof item.key === 'string'
                  ? []
                  : [
                      <option key={item.key.property} value={item.key.property}>
                        {item.label}
                      </option>,
                    ],
              )}
            </select>
            <select
              aria-label="Filter comparison"
              data-testid="board-filter-op"
              value={filterOp}
              onChange={(e) =>
                setFilterOp(e.target.value as FindFilterClause['op'])
              }
            >
              <option value="eq">is</option>
              <option value="gte">at least</option>
              <option value="lte">at most</option>
            </select>
            <input
              aria-label="Filter value"
              data-testid="board-filter-value"
              placeholder="Value"
              value={filterValue}
              onChange={(e) => setFilterValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addFilter();
              }}
            />
            <button
              type="button"
              data-testid="board-filter-add"
              onClick={addFilter}
              disabled={!filterKey || !filterValue.trim()}
            >
              Add filter
            </button>
          </>
        )}
        <button
          type="button"
          data-testid="board-filter-clear"
          onClick={() => dispatch({ type: 'clear' })}
        >
          Clear
        </button>
      </div>
      {(filters.length > 0 || claim || like) && (
        <div className="row board-find-chips">
          {like && (
            <button
              type="button"
              data-testid="board-like-chip"
              onClick={() => dispatch({ type: 'like', image: null })}
            >
              Looks like: {like.name}
              <Icon name="close" size={14} />
            </button>
          )}
          {claim && (
            <button
              type="button"
              data-testid="board-claim-chip"
              onClick={() => dispatch({ type: 'claim', claim: null })}
            >
              {claim.kind === 'label' ? 'Label' : 'Relation'}: {claim.term}
              <Icon name="close" size={14} />
            </button>
          )}
          {filters.map((clause) => (
            <button
              type="button"
              key={clause.key}
              data-testid={`board-filter-chip-${clause.key}`}
              onClick={() => dispatch({ type: 'unfilter', key: clause.key })}
            >
              {clause.key} {clause.op} {String(clause.value)}
              <Icon name="close" size={14} />
            </button>
          ))}
        </div>
      )}
      {isSet(question) && (
        <div className="row board-find-result" aria-live="polite">
          {error ? (
            <output>{error}</output>
          ) : result ? (
            <>
              <span data-testid="board-find-count">
                {result.ranked
                  ? `Best ${result.count}, closest first`
                  : `${result.count} ${result.count === 1 ? 'match' : 'matches'}`}
                {result.ranks.length < result.count
                  ? ` · showing first ${result.ranks.length} on map`
                  : ''}
              </span>
              <button
                type="button"
                data-testid="board-find-select-matches"
                onClick={onSelectAll}
                disabled={!result.imageIds.length}
              >
                {result.count > result.imageIds.length
                  ? `Select first ${result.imageIds.length} of ${result.count}`
                  : `Select ${result.count} ${result.count === 1 ? 'match' : 'matches'}`}
              </button>
              {result.ranked && result.count >= question.limit && (
                <button
                  type="button"
                  data-testid="board-find-more"
                  onClick={() => dispatch({ type: 'more' })}
                >
                  Show more
                </button>
              )}
              {result.ranked && (
                <ol className="board-find-strip" data-testid="board-find-strip">
                  {result.imageIds
                    .slice(0, MEANING_STRIP)
                    .map((imageId, order) => (
                      <li key={imageId}>
                        <button
                          type="button"
                          aria-label={`Match ${order + 1}: show it on the map`}
                          data-testid="board-find-strip-item"
                          onClick={() =>
                            onShowOnMap(imageId, result.ranks[order] ?? -1)
                          }
                        >
                          <img
                            src={api.previewUrl(imageId)}
                            alt=""
                            loading="lazy"
                          />
                        </button>
                      </li>
                    ))}
                </ol>
              )}
            </>
          ) : (
            <span>Searching…</span>
          )}
        </div>
      )}
    </div>
  );
}
