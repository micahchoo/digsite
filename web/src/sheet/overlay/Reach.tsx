// Where this sheet's images lead that the sheet does not show (CONTEXT.md
// "Reach"). An image with connections on other sheets gets a badge; open
// it and the far images fan out beside it, each with the relation that
// leads there and the sheet that said so. One click brings a far image
// onto this sheet, where the connection becomes an ordinary foreign edge.
//
// Overlay only: nothing here is an element, enters undo, or is saved
// (../../../.claude/rules/foreign-never-in-scene.md).
import type {
  ReachEdge,
  ReachImage,
  Reach as ReachRows,
} from '@digsite/shared';
import { dataOf } from '@digsite/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../components/Icon.tsx';
import { api } from '../../lib/api.ts';
import { plural } from '../../lib/plural.ts';
import {
  type ContainerOffset,
  type ElementLike,
  type Viewport,
  rectToScreen,
} from './screen.ts';

interface Props {
  rows: ReachRows;
  elements: readonly ElementLike[];
  viewport: Viewport;
  offset: ContainerOffset;
  /** Adds the far image to this sheet; resolves when the server accepted it. */
  onBring: (imageId: string) => Promise<void>;
}

/** Far images shown per open badge; the rest are counted. */
const FAN_LIMIT = 6;
const CARD_H = 64;
const CARD_GAP = 8;
const FAN_W = 260;
const FAN_GAP = 28;

/**
 * Where the fan opens: beside the image on the side with room, clear of the
 * floating details panel, and kept inside the canvas vertically. A fan
 * that opens off-screen is a badge that does nothing.
 */
function fanSpot(
  box: { x: number; y: number; width: number; height: number },
  height: number,
  layer: HTMLElement | null,
): { left: number; top: number; side: 'right' | 'left' } {
  const right = box.x + box.width + FAN_GAP;
  const left = box.x - FAN_GAP - FAN_W;
  let top = box.y + box.height / 2 - height / 2;
  if (!layer) return { left: right, top, side: 'right' };
  const area = layer.getBoundingClientRect();
  top = Math.max(8, Math.min(top, area.height - height - 8));
  const panel = document
    .getElementById('sheet-inspector-panel')
    ?.getBoundingClientRect();
  const free = (x: number) => {
    if (x < 8 || x + FAN_W > area.width - 8) return false;
    if (!panel || panel.width === 0) return true;
    const l = area.left + x;
    const t = area.top + top;
    return (
      l + FAN_W < panel.left ||
      l > panel.right ||
      t + height < panel.top ||
      t > panel.bottom
    );
  };
  if (free(right)) return { left: right, top, side: 'right' };
  if (free(left)) return { left, top, side: 'left' };
  return { left: right, top, side: 'right' };
}

type Lead = { image: ReachImage; edges: ReachEdge[] };

/** Reach edges grouped by the image on this sheet, then by far image. */
export function leadsByImage(rows: ReachRows): Map<string, Lead[]> {
  const images = new Map(rows.images.map((i) => [i.id, i]));
  const out = new Map<string, Map<string, Lead>>();
  for (const edge of rows.edges) {
    const near = edge.near === 'source' ? edge.source : edge.target;
    const far = edge.near === 'source' ? edge.target : edge.source;
    const image = images.get(far.imageId);
    if (!image) continue;
    let byFar = out.get(near.imageId);
    if (!byFar) {
      byFar = new Map();
      out.set(near.imageId, byFar);
    }
    const lead = byFar.get(far.imageId) ?? { image, edges: [] };
    lead.edges.push(edge);
    byFar.set(far.imageId, lead);
  }
  return new Map([...out].map(([k, v]) => [k, [...v.values()]]));
}

export function Reach({ rows, elements, viewport, offset, onBring }: Props) {
  const [open, setOpen] = useState<string | null>(null);
  const [bringing, setBringing] = useState<string | null>(null);
  const layerRef = useRef<HTMLDivElement | null>(null);
  const leads = useMemo(() => leadsByImage(rows), [rows]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(null);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const images = elements.filter((el) => {
    if (el.isDeleted) return false;
    const d = dataOf(el);
    return d?.kind === 'image' && leads.has(d.imageId);
  });
  if (!images.length) return null;

  return (
    <div ref={layerRef} className="sheet-reach" data-testid="reach">
      {images.map((el) => {
        const data = dataOf(el);
        if (data?.kind !== 'image') return null;
        const imageLeads = leads.get(data.imageId) ?? [];
        const box = rectToScreen(el, viewport, offset);
        const isOpen = open === data.imageId;
        const shown = imageLeads.slice(0, FAN_LIMIT);
        const fanHeight = shown.length * (CARD_H + CARD_GAP) - CARD_GAP;
        const { left, top, side } = fanSpot(box, fanHeight, layerRef.current);
        const lineX = side === 'right' ? box.x + box.width : box.x;
        const cardX = side === 'right' ? left : left + FAN_W;
        return (
          <div key={el.id}>
            <button
              type="button"
              className="sheet-reach-badge"
              data-testid={`reach-badge-${data.imageId}`}
              aria-expanded={isOpen}
              aria-label={`${plural(imageLeads.length, 'connected image')} on other sheets`}
              style={{ left: box.x + box.width - 8, top: box.y + 8 }}
              onClick={() => setOpen(isOpen ? null : data.imageId)}
            >
              <Icon name="connect" size={12} />
              {imageLeads.length} elsewhere
            </button>
            {isOpen && (
              <>
                <svg aria-hidden="true" className="sheet-reach-lines">
                  {shown.map((lead, i) => (
                    <line
                      key={lead.image.id}
                      x1={lineX}
                      y1={box.y + box.height / 2}
                      x2={cardX}
                      y2={top + i * (CARD_H + CARD_GAP) + CARD_H / 2}
                    />
                  ))}
                </svg>
                <ul
                  className="sheet-reach-fan"
                  aria-label="Images this one leads to"
                  style={{ left, top }}
                >
                  {shown.map((lead) => {
                    const first = lead.edges[0];
                    return (
                      <li key={lead.image.id}>
                        <button
                          type="button"
                          className="sheet-reach-card"
                          data-testid={`reach-card-${lead.image.id}`}
                          disabled={
                            bringing === lead.image.id || lead.image.missing
                          }
                          title={`Bring ${lead.image.name} onto this sheet`}
                          onClick={() => {
                            setBringing(lead.image.id);
                            void onBring(lead.image.id).finally(() =>
                              setBringing(null),
                            );
                          }}
                        >
                          <img
                            src={api.previewUrl(lead.image.id)}
                            alt=""
                            loading="lazy"
                          />
                          <span className="sheet-reach-copy">
                            <span className="sheet-reach-relation">
                              {first?.relation || 'Unnamed'}
                              {lead.edges.length > 1 &&
                                ` +${lead.edges.length - 1}`}
                            </span>
                            <span className="sheet-reach-meta">
                              {lead.image.name} · {first?.sheetName}
                            </span>
                          </span>
                          <span className="sheet-reach-bring">
                            {bringing === lead.image.id
                              ? 'Adding…'
                              : 'Bring here'}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                  {imageLeads.length > shown.length && (
                    <li className="sheet-reach-more">
                      {plural(imageLeads.length - shown.length, 'more image')}
                    </li>
                  )}
                </ul>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
