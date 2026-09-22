// The right-hand panel: `Header` (the presence strip that replaced the old
// debug status line), `Dangling` (the "remove dangling" list) and
// `Inspector`, composed in one file per docs/phases/2-sheet.md section 7.
// Styling is `sheet.css` classes only — no inline styles.
import type { PropertyValue } from '@digsite/shared';
import { RenameInline } from '../components/RenameInline.tsx';
import { plural } from '../lib/plural.ts';
import { Inspector } from './Inspector.tsx';
import { colorForUser, namedPeers } from './presence.ts';
import type { Peer, RoomStatus } from './room.ts';
import type { DanglingEdge, Selected } from './tools.ts';

interface HeaderProps {
  name: string;
  onRename: (name: string) => Promise<void> | void;
  imageCount: number;
  peers: Peer[];
  userEmail: string | undefined;
  foreignCount: number;
  status: RoomStatus;
}

function Header({
  name,
  onRename,
  imageCount,
  peers,
  userEmail,
  foreignCount,
  status,
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
      <RenameInline
        name={name}
        onRename={onRename}
        testId="sheet-name"
        style={{ fontWeight: 700 }}
      />
      <div className="sheet-header-meta">{plural(imageCount, 'image')}</div>
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
}: SidePanelProps) {
  return (
    <div className="sheet-side">
      <Header {...header} />
      <Dangling items={dangling} onRemove={onRemoveDangling} />
      <Inspector
        selected={selected}
        onSetProperty={onSetProperty}
        onRemoveProperty={onRemoveProperty}
        onCopyForeign={onCopyForeign}
        onDeleteSelected={onDeleteSelected}
      />
    </div>
  );
}
