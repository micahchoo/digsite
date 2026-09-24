// The right-hand panel: `Header` (the presence strip that replaced the old
// debug status line), `Dangling` (the "remove dangling" list) and
// `Inspector`, composed in one file per docs/phases/2-sheet.md section 7.
// Styling is `sheet.css` classes only — no inline styles.
import { useEffect, useId, useRef } from 'react';
import { Link } from 'react-router';
import { Icon } from '../components/Icon.tsx';
import { RenameInline } from '../components/RenameInline.tsx';
import { plural } from '../lib/plural.ts';
import { Inspector, type InspectorProps } from './Inspector.tsx';
import { colorForUser, namedPeers } from './presence.ts';
import type { Peer, RoomStatus } from './room.ts';
import type { DanglingEdge } from './tools.ts';

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
  /** Every relation on the sheet, own and other sheets', most used first. */
  relations: { relation: string; count: number }[];
  connectionRelation: string | null;
  onConnectionRelationChange: (relation: string | null) => void;
  /** Downloads the sheet's claims as one self-contained document. */
  onExportReport?: () => void;
  /** Keeps the report on digsite, with an id, and downloads it. */
  onKeepReport?: () => void;
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
  relations,
  connectionRelation,
  onConnectionRelationChange,
  onExportReport,
  onKeepReport,
}: HeaderProps) {
  const relationGroup = useId();
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
            <Icon name="arrowLeft" size={16} />
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
            <Icon name="arrowRight" size={16} />
          </button>
        </div>
        <button
          ref={closeButtonRef}
          type="button"
          className="sheet-mobile-inspector-close"
          aria-label="Close sheet details"
          onClick={onCloseMobile}
        >
          <Icon name="close" size={16} />
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
      {onExportReport && (
        <button
          type="button"
          className="sheet-header-action"
          data-testid="export-report"
          onClick={onExportReport}
        >
          Export a report
        </button>
      )}
      {onKeepReport && (
        <button
          type="button"
          className="sheet-header-action"
          data-testid="keep-report"
          title="Keep it on digsite with an id, to cite it and see what changes"
          onClick={onKeepReport}
        >
          Keep a report
        </button>
      )}
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
      <div className="sheet-header-meta" data-testid="sync-state">
        {status.lastEmitAt === null
          ? 'No changes yet'
          : `Synced ${agoText(savedSecondsAgo ?? 0)}`}
      </div>
      {relations.length > 0 && (
        <fieldset
          className="sheet-relations"
          data-testid="relation-emphasis"
          aria-describedby="relation-emphasis-help"
        >
          <legend>Relations on this sheet</legend>
          <div className="sheet-relations-chips">
            <label>
              <input
                type="radio"
                name={relationGroup}
                checked={connectionRelation === null}
                onChange={() => onConnectionRelationChange(null)}
              />
              All
            </label>
            {relations.map(({ relation, count }) => (
              <label key={relation || 'no-relation'}>
                <input
                  type="radio"
                  name={relationGroup}
                  checked={connectionRelation === relation}
                  data-testid="relation-emphasis-option"
                  onChange={() => onConnectionRelationChange(relation)}
                />
                {relation || 'unnamed'}
                <span className="sheet-relations-count">{count}</span>
              </label>
            ))}
          </div>
          <small id="relation-emphasis-help">
            Choosing one dims the others; nothing is removed.
          </small>
        </fieldset>
      )}
      <div className="visually-hidden" data-testid="status">
        {statusText}
      </div>
    </div>
  );
}

/** "just now", "12s ago", "3 min ago": how long since the last sync. */
function agoText(seconds: number): string {
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.round(seconds / 60)} min ago`;
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
  inspector: InspectorProps;
  mobileOpen: boolean;
  onFocusToggle: () => void;
}

export function SidePanel({
  header,
  dangling,
  onRemoveDangling,
  inspector,
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
      <Inspector {...inspector} />
    </aside>
  );
}
