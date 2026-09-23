// Opens where a new connection lands: name it from the board's vocabulary,
// set its direction and how sure you are, in the same place you drew it.
// Enter names it and closes. Escape or a click elsewhere closes and keeps
// whatever was typed; the edge itself stays either way, unnamed if nothing
// was typed, exactly as a new region stays when its label is skipped.
import type { Confidence, Direction, VocabularyTerm } from '@digsite/shared';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { TermInput } from '../components/TermInput.tsx';
import { ConfidenceControl, DirectionControl } from './ClaimControls.tsx';
import type { Point } from './overlay/screen.ts';

interface Props {
  at: Point;
  relation: string;
  direction: Direction;
  confidence: Confidence | undefined;
  terms: readonly VocabularyTerm[];
  onRelation: (relation: string) => void;
  onDirection: (direction: Direction) => void;
  onConfidence: (confidence: Confidence | null) => void;
  onClose: () => void;
}

const WIDTH = 280;

export function RelationPicker({
  at,
  relation,
  direction,
  confidence,
  terms,
  onRelation,
  onDirection,
  onConfidence,
  onClose,
}: Props) {
  const [draft, setDraft] = useState(relation);
  const cardRef = useRef<HTMLDialogElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [place, setPlace] = useState<{ left: number; top: number }>({
    left: at.x - WIDTH / 2,
    top: at.y + 12,
  });

  // Keep the card inside the canvas area: it opens at the connection's
  // midpoint, which can sit at any edge of the view.
  useLayoutEffect(() => {
    const card = cardRef.current;
    const area = card?.offsetParent as HTMLElement | null;
    if (!card || !area) return;
    const maxLeft = area.clientWidth - card.offsetWidth - 8;
    const maxTop = area.clientHeight - card.offsetHeight - 8;
    const below = at.y + 12;
    const above = at.y - card.offsetHeight - 12;
    setPlace({
      left: Math.max(8, Math.min(at.x - card.offsetWidth / 2, maxLeft)),
      top: Math.max(8, below <= maxTop ? below : above),
    });
  }, [at.x, at.y]);

  useEffect(() => inputRef.current?.focus(), []);

  const commitAndClose = useRef(() => {});
  commitAndClose.current = () => {
    if (draft.trim() !== relation) onRelation(draft.trim());
    onClose();
  };

  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (!cardRef.current?.contains(e.target as Node))
        commitAndClose.current();
    }
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, []);

  return (
    <dialog
      open
      ref={cardRef}
      className="sheet-relation-picker"
      data-testid="relation-picker"
      aria-label="Name this connection"
      style={{ left: place.left, top: place.top, width: WIDTH }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !e.defaultPrevented) {
          e.stopPropagation();
          commitAndClose.current();
        }
      }}
    >
      <TermInput
        ref={inputRef}
        aria-label="Relation"
        data-testid="relation-picker-input"
        placeholder="Name this connection…"
        list="inline"
        value={draft}
        terms={terms}
        onChange={setDraft}
        onCommit={(value) => {
          onRelation(value.trim());
          onClose();
        }}
      />
      <div className="sheet-relation-picker-row">
        <DirectionControl value={direction} onChange={onDirection} />
      </div>
      <div className="sheet-relation-picker-row">
        <ConfidenceControl value={confidence} onChange={onConfidence} />
      </div>
    </dialog>
  );
}
