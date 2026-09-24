// docs/ux/design.md §3.5: Ctrl/Cmd+K anywhere in the shell, fuzzy-matched
// against every group/board/sheet the viewer can see — from data the
// shell already loaded for the rail/channel column, no new endpoint.
// Grouped by type, 8 max per group, arrow keys move, Enter navigates,
// Escape closes. A combobox/listbox pair for a11y (design's own
// requirement, and `better-accessibility`'s "label and type every
// control").
import type { BoardSummary, GroupThreadSummary } from '@digsite/shared/api';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Icon, type IconName } from '../components/Icon.tsx';
import type { api } from '../lib/api.ts';
import { fuzzyScore } from './fuzzy.ts';

export interface SwitcherEntry {
  id: string;
  kind: 'group' | 'board' | 'sheet';
  label: string;
  sub?: string;
  to: string;
}

const GLYPH: Record<SwitcherEntry['kind'], IconName> = {
  group: 'group',
  board: 'hash',
  sheet: 'sheet',
};
const GROUP_LABEL: Record<SwitcherEntry['kind'], string> = {
  group: 'Groups',
  board: 'Boards',
  sheet: 'Sheets',
};
const MAX_PER_GROUP = 8;

interface Props {
  open: boolean;
  onClose: () => void;
  groups: Awaited<ReturnType<typeof api.listGroups>>;
  boards: BoardSummary[];
  sheetsByBoard: Record<string, GroupThreadSummary[]>;
}

export function QuickSwitcher({
  open,
  onClose,
  groups,
  boards,
  sheetsByBoard,
}: Props) {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);

  const entries = useMemo<SwitcherEntry[]>(() => {
    const boardById = new Map(boards.map((b) => [b.id, b]));
    const out: SwitcherEntry[] = [];
    for (const g of groups) {
      out.push({
        id: `group:${g.id}`,
        kind: 'group',
        label: g.name,
        to: `/g/${g.id}`,
      });
    }
    for (const b of boards) {
      out.push({
        id: `board:${b.id}`,
        kind: 'board',
        label: b.name,
        to: `/b/${b.id}`,
      });
    }
    for (const [boardId, sheets] of Object.entries(sheetsByBoard)) {
      const boardName = boardById.get(boardId)?.name;
      for (const s of sheets) {
        out.push({
          id: `sheet:${s.id}`,
          kind: 'sheet',
          label: s.name,
          sub: boardName,
          to: `/s/${s.id}`,
        });
      }
    }
    return out;
  }, [groups, boards, sheetsByBoard]);

  const results = useMemo(() => {
    const scored = entries
      .map((e) => ({ e, score: fuzzyScore(query, e.label) }))
      .filter((x): x is { e: SwitcherEntry; score: number } => x.score !== null)
      .sort((a, b) => b.score - a.score);
    const byKind: Record<SwitcherEntry['kind'], SwitcherEntry[]> = {
      group: [],
      board: [],
      sheet: [],
    };
    for (const { e } of scored) {
      if (byKind[e.kind].length < MAX_PER_GROUP) byKind[e.kind].push(e);
    }
    const flat: SwitcherEntry[] = [
      ...byKind.group,
      ...byKind.board,
      ...byKind.sheet,
    ];
    return { byKind, flat };
  }, [entries, query]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setHighlight(0);
      // Autofocus needs the element mounted first.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Reset the highlight to the first result whenever the query (and so the
  // result set) changes, not on every render.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset is triggered BY a query change, not by reading it
  useEffect(() => {
    setHighlight(0);
  }, [query]);

  if (!open) return null;

  function navigateTo(entry: SwitcherEntry | undefined) {
    if (!entry) return;
    onClose();
    navigate(entry.to);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) =>
        Math.min(h + 1, Math.max(results.flat.length - 1, 0)),
      );
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      navigateTo(results.flat[highlight]);
    }
  }

  let flatIndex = -1;

  return (
    <div
      className="shell-switcher-scrim"
      data-testid="quick-switcher"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="shell-switcher" role="presentation">
        <input
          ref={inputRef}
          role="combobox"
          aria-expanded="true"
          aria-controls="quick-switcher-listbox"
          aria-autocomplete="list"
          aria-activedescendant={
            results.flat[highlight]
              ? `qs-${results.flat[highlight].id}`
              : undefined
          }
          className="shell-switcher-input"
          placeholder="Jump to a group, board or sheet…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          data-testid="quick-switcher-input"
        />
        {/* A combobox/listbox pair (WAI-ARIA 1.2 "Editable Combobox With
            List Autocomplete"), not a native <select>: it needs icons and a
            secondary "which board" label per row that <option> cannot
            render, and the input (not the listbox) keeps DOM focus the
            whole time via aria-activedescendant — the standard shape for a
            searchable combobox, so the listbox itself takes no tabIndex.
            biome's useSemanticElements rule has no working inline
            suppression for a role spread across a formatted multi-line
            attribute list (biome.json's overrides turns it off for this
            file instead — see that file's own comment). */}
        {/* biome-ignore lint/a11y/useFocusableInteractive: aria-activedescendant keeps focus on the input, by design (WAI-ARIA combobox pattern) */}
        <div
          id="quick-switcher-listbox"
          role="listbox"
          className="shell-switcher-results"
          data-testid="quick-switcher-results"
        >
          {(['group', 'board', 'sheet'] as const).map((kind) => {
            const list = results.byKind[kind];
            if (!list.length) return null;
            return (
              <div key={kind} className="shell-switcher-group">
                <div className="shell-switcher-group-label">
                  {GROUP_LABEL[kind]}
                </div>
                {list.map((entry) => {
                  flatIndex++;
                  const idx = flatIndex;
                  return (
                    <button
                      type="button"
                      key={entry.id}
                      id={`qs-${entry.id}`}
                      role="option"
                      aria-selected={idx === highlight}
                      className={
                        idx === highlight
                          ? 'shell-switcher-item shell-switcher-item--active'
                          : 'shell-switcher-item'
                      }
                      data-testid="quick-switcher-item"
                      onMouseEnter={() => setHighlight(idx)}
                      onClick={() => navigateTo(entry)}
                    >
                      <Icon
                        name={GLYPH[entry.kind]}
                        size={16}
                        className="shell-switcher-glyph"
                      />
                      <span>{entry.label}</span>
                      {entry.sub && (
                        <span className="shell-switcher-sub muted">
                          {entry.sub}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            );
          })}
          {results.flat.length === 0 && (
            <div className="shell-switcher-empty muted">No matches.</div>
          )}
        </div>
      </div>
    </div>
  );
}
