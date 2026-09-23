// The right-hand panel: `Header` (the presence strip that replaced the old
// debug status line), `Dangling` (the "remove dangling" list) and
// `Inspector`, composed in one file per docs/phases/2-sheet.md section 7.
// Styling is `sheet.css` classes only — no inline styles.
import type { PropertyValue } from '@digsite/shared';
import { useEffect, useRef } from 'react';
import { Link } from 'react-router';
import { RenameInline } from '../components/RenameInline.tsx';
import { plural } from '../lib/plural.ts';
import { Inspector } from './Inspector.tsx';
import { colorForUser, namedPeers } from './presence.ts';
import type { Peer, RoomStatus } from './room.ts';
import type { DanglingEdge, Selected } from './tools.ts';

interface SheetNeighbor {
  id: string;
  name: string;
}

interface HeaderProps {
  name: string;
  onRename: (name: string) => Promise<void> | void;
  imageCount: number;
  peers: Peer[];
  userEmail: string | undefined;
  foreignCount: number;
  status: RoomStatus;
  // Slice 2 (docs/ux/design.md §5.1 "Ways to select": "Sheet -> 'Show on
  // board' returns to the board with that sheet's images selected, map
  // scrolled to the first"). Board.tsx reads the `showSheet` query param on
  // mount. A minimal link here, not a full `⋯` menu — that menu is slice
  // 3's job (sheet chrome); this is the one item slice 2's own done-walk
  // needs from the sheet side.
  boardId: string;
  sheetId: string;
  previousSheet: SheetNeighbor | null;
  nextSheet: SheetNeighbor | null;
  onNavigateSheet: (id: string) => void;
  onCloseMobile: () => void;
  closeButtonRef: React.RefObject<HTMLButtonElement | null>;
  foreignRelations: string[];
  connectionRelation: string | null;
  onConnectionRelationChange: (relation: string | null) => void;
}

function Header({
  name,
  onRename,
  imageCount,
  peers,
  userEmail,
  foreignCount,
  status,
  boardId,
  sheetId,
  previousSheet,
  nextSheet,
  onNavigateSheet,
  onCloseMobile,
  closeButtonRef,
  foreignRelations,
  connectionRelation,
  onConnectionRelationChange,
}: HeaderProps) {
  const lastSyncAt = Math.max(status.lastEmitAt ?? 0, status.lastRecvAt ?? 0);
  const lastSyncMs = lastSyncAt ? Date.now() - lastSyncAt : null;
  const savedSecondsAgo =
    lastSyncMs === null ? null : Math.round(lastSyncMs / 1000);
  // The exact text the debug status line carried before the split —
  // preserved verbatim, visually hidden, for anything that still reads it.
  const statusText = `user=${userEmail ?? '-'} sheet=${name} peers=${
    peers.map((p) => p.name).join(',') || '-'
  } foreign=${foreignCount} lastSync=${lastSyncMs === null ? '-' : `${lastSyncMs}ms`}`;
  return (
    <div className="sheet-header">
      <div className="sheet-header-topline">
        <div
          className="sheet-sheet-navigation"
          aria-label="Sheets on this board"
        >
          <button
            type="button"
            aria-label={
              previousSheet
                ? `Previous sheet: ${previousSheet.name}`
                : 'No previous sheet'
            }
            title={previousSheet?.name}
            disabled={!previousSheet}
            onClick={() => {
              if (previousSheet) onNavigateSheet(previousSheet.id);
            }}
          >
            <span aria-hidden="true">←</span>
          </button>
          <button
            type="button"
            aria-label={
              nextSheet ? `Next sheet: ${nextSheet.name}` : 'No next sheet'
            }
            title={nextSheet?.name}
            disabled={!nextSheet}
            onClick={() => {
              if (nextSheet) onNavigateSheet(nextSheet.id);
            }}
          >
            <span aria-hidden="true">→</span>
          </button>
        </div>
        <button
          ref={closeButtonRef}
          type="button"
          className="sheet-mobile-inspector-close"
          aria-label="Close sheet details"
          onClick={onCloseMobile}
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>
      <RenameInline name={name} onRename={onRename} testId="sheet-name" />
      <div className="sheet-header-meta">{plural(imageCount, 'image')}</div>
      <Link
        to={`/b/${boardId}?showSheet=${sheetId}`}
        data-testid="show-on-board"
        className="sheet-header-meta"
      >
        Show on board
      </Link>
      {peers.length > 0 && (
        <div className="sheet-presence" data-testid="presence-strip">
          {/* docs/ux/audit.md #11: a peer with no name yet is skipped
              rather than shown by its raw user id — see
              presence.ts#namedPeers. */}
          {namedPeers(peers).map((p) => (
            <span
              key={p.id}
              className="sheet-presence-chip"
              style={{ ['--chip-color' as string]: colorForUser(p.id) }}
            >
              {p.name}
            </span>
          ))}
        </div>
      )}
      <div className="sheet-header-meta">
        {savedSecondsAgo === null
          ? 'not saved yet'
          : `saved ${savedSecondsAgo}s ago`}
      </div>
      {foreignRelations.length > 0 && (
        <div className="sheet-foreign-relation-filter">
          <label htmlFor="foreign-relation-filter">
            Other sheets’ connections
          </label>
          <select
            id="foreign-relation-filter"
            aria-describedby="foreign-relation-help"
            value={
              connectionRelation === null
                ? ''
                : String(foreignRelations.indexOf(connectionRelation) + 1)
            }
            onChange={(event) => {
              const index = Number(event.target.value) - 1;
              onConnectionRelationChange(
                index < 0 ? null : (foreignRelations[index] ?? null),
              );
            }}
          >
            <option value="">All connections</option>
            {foreignRelations.map((relation, index) => (
              <option key={relation || 'no-relation'} value={index + 1}>
                {relation || '(no relation)'}
              </option>
            ))}
          </select>
          <small id="foreign-relation-help">
            Other relations dim. This sheet’s connections are unchanged.
          </small>
        </div>
      )}
      <div className="visually-hidden" data-testid="status">
        {statusText}
      </div>
    </div>
  );
}

interface DanglingProps {
  items: DanglingEdge[];
  onRemove: () => void;
}

function Dangling({ items, onRemove }: DanglingProps) {
  if (!items.length) return null;
  return (
    <div data-testid="dangling-list" className="sheet-dangling">
      <div className="sheet-dangling-title">dangling ({items.length})</div>
      {items.map((d) => (
        <div key={d.id} className="sheet-header-meta">
          {d.relation || '(no relation)'}
        </div>
      ))}
      <button type="button" data-testid="remove-dangling" onClick={onRemove}>
        Remove dangling
      </button>
    </div>
  );
}

export interface SidePanelProps {
  header: HeaderProps;
  dangling: DanglingEdge[];
  onRemoveDangling: () => void;
  selected: Selected | null;
  onSetProperty: (id: string, key: string, value: PropertyValue) => void;
  onRemoveProperty: (id: string, key: string) => void;
  onCopyForeign: (id: string) => void;
  onDeleteSelected: () => void;
  mobileOpen: boolean;
  onFocusToggle: () => void;
}

export function SidePanel({
  header,
  dangling,
  onRemoveDangling,
  selected,
  onSetProperty,
  onRemoveProperty,
  onCopyForeign,
  onDeleteSelected,
  mobileOpen,
  onFocusToggle,
}: SidePanelProps) {
  const wasOpen = useRef(false);
  const panelRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (mobileOpen) {
      header.closeButtonRef.current?.focus();
    } else if (wasOpen.current) {
      onFocusToggle();
    }
    wasOpen.current = mobileOpen;
  }, [mobileOpen, header.closeButtonRef, onFocusToggle]);

  function trapTab(e: React.KeyboardEvent<HTMLElement>) {
    if (!mobileOpen || e.key !== 'Tab') return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusable = Array.from(
      panel.querySelectorAll<HTMLElement>(
        'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => element.getClientRects().length > 0);
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) {
      e.preventDefault();
      panel.focus();
    } else if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  return (
    <aside
      ref={panelRef}
      id="sheet-inspector-panel"
      className={`sheet-side${mobileOpen ? ' sheet-side--mobile-open' : ''}`}
      role={mobileOpen ? 'dialog' : 'complementary'}
      aria-modal={mobileOpen || undefined}
      aria-label="Sheet details"
      tabIndex={mobileOpen ? -1 : undefined}
      onKeyDown={trapTab}
    >
      <Header {...header} />
      <Dangling items={dangling} onRemove={onRemoveDangling} />
      <Inspector
        selected={selected}
        onSetProperty={onSetProperty}
        onRemoveProperty={onRemoveProperty}
        onCopyForeign={onCopyForeign}
        onDeleteSelected={onDeleteSelected}
      />
    </aside>
  );
}
