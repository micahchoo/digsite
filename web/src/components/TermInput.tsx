// A label or relation field that suggests from the board's vocabulary
// (CONTEXT.md "Vocabulary"): most-used first, matched through aliases, and
// a spelling that only differs from an existing term is shown as that term.
// The shared names are what make a group's graph explorable at all.
//
// An ARIA 1.2 combobox with list autocomplete. Nothing is pre-selected, so
// Enter always keeps exactly what was typed; the arrow keys move into the
// list and Enter then takes the highlighted term.
import {
  type VocabularyTerm,
  duplicateOf,
  suggestTerms,
} from '@digsite/shared';
import { forwardRef, useId, useState } from 'react';
import { plural } from '../lib/plural.ts';

interface Props {
  value: string;
  terms: readonly VocabularyTerm[];
  onChange: (value: string) => void;
  /** Enter, or a term picked from the list. */
  onCommit: (value: string) => void;
  /** Escape with the list closed. */
  onCancel?: () => void;
  onBlur?: () => void;
  placeholder?: string;
  /** 'inline' puts the suggestions in the flow, so a card holding the field
   * grows instead of being covered. */
  list?: 'float' | 'inline';
  'aria-label': string;
  'data-testid'?: string;
  className?: string;
  style?: React.CSSProperties;
}

export const TermInput = forwardRef<HTMLInputElement, Props>(function TermInput(
  {
    value,
    terms,
    onChange,
    onCommit,
    onCancel,
    onBlur,
    placeholder,
    list = 'float',
    className,
    style,
    ...aria
  },
  ref,
) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);

  const duplicate = duplicateOf(value, terms);
  const suggestions = suggestTerms(value, terms).filter(
    (t) => t.term !== value,
  );
  const showList = open && suggestions.length > 0;

  function pick(term: string) {
    onChange(term);
    onCommit(term);
    setOpen(false);
    setActive(-1);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, -1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const chosen = active >= 0 ? suggestions[active] : undefined;
      if (chosen) pick(chosen.term);
      else {
        setOpen(false);
        onCommit(value);
      }
    } else if (e.key === 'Escape') {
      if (showList && active >= 0) {
        e.preventDefault();
        e.stopPropagation();
        setActive(-1);
        setOpen(false);
      } else {
        onCancel?.();
      }
    }
  }

  return (
    <span
      className={`term-input${className ? ` ${className}` : ''}`}
      style={style}
    >
      <input
        ref={ref}
        {...aria}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={showList}
        aria-controls={listId}
        aria-activedescendant={
          showList && active >= 0 ? `${listId}-${active}` : undefined
        }
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          setOpen(false);
          setActive(-1);
          onBlur?.();
        }}
        onKeyDown={onKeyDown}
      />
      {showList && (
        // The ARIA 1.2 combobox pattern: focus stays in the input, which owns
        // every key, and aria-activedescendant names the option. The list and
        // its options are deliberately not focusable.
        // biome-ignore lint/a11y/useFocusableInteractive: focus stays in the combobox input
        <ul
          className={`term-input-list term-input-list--${list}`}
          id={listId}
          // biome-ignore lint/a11y/useSemanticElements: a <select> cannot hang under a free-text input
          // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: listbox of the combobox pattern
          role="listbox"
        >
          {suggestions.map((t, i) => (
            // biome-ignore lint/a11y/useFocusableInteractive: focus stays in the combobox input
            // biome-ignore lint/a11y/useKeyWithClickEvents: the input handles every key for the list
            <li
              key={t.term}
              id={`${listId}-${i}`}
              // biome-ignore lint/a11y/useSemanticElements: option of the combobox pattern
              // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: option of the combobox pattern
              role="option"
              aria-selected={i === active}
              className="term-input-option"
              // Keep focus in the input: a mousedown would blur it first.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(t.term)}
              onMouseEnter={() => setActive(i)}
            >
              <span className="term-input-term">{t.term}</span>
              <span className="term-input-meta">
                {t.term === duplicate ? 'Same term' : plural(t.count, 'use')}
              </span>
            </li>
          ))}
        </ul>
      )}
    </span>
  );
});
