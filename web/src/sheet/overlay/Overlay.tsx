// The foreign layer: an <svg> above the Excalidraw container. pointer-events
// is 'none' on the svg itself and 'all' on each shape, so a click on empty
// canvas falls through to Excalidraw underneath and a click on a foreign
// shape never reaches it — see ../../../.claude/rules/foreign-never-in-scene.md.
//
// Presence (docs/phases/2-sheet.md section 3) shares this layer: a peer's
// named cursor and a faint outline of their current selection, computed by
// ../presence.ts and passed in as `peers` — informational only, so every
// peer element here is `pointerEvents: 'none'`.
import type { Foreign } from '@digsite/shared';
import { useMemo } from 'react';
import type { PeerCursor } from '../presence.ts';
import {
  type ContainerOffset,
  type ElementLike,
  type Viewport,
  foreignShapes,
  rectToScreen,
  sceneToScreen,
} from './screen.ts';

interface Props {
  rows: Foreign;
  elements: readonly ElementLike[];
  viewport: Viewport;
  offset: ContainerOffset;
  selectedId: string | null;
  connectionRelation: string | null;
  onSelect: (id: string) => void;
  peers?: PeerCursor[];
}

export function Overlay({
  rows,
  elements,
  viewport,
  offset,
  selectedId,
  connectionRelation,
  onSelect,
  peers = [],
}: Props) {
  const shapes = useMemo(() => foreignShapes(rows, elements), [rows, elements]);

  return (
    // Excalidraw's own interactive canvas sits at z-index 2
    // (--zIndex-interactiveCanvas); an unset z-index here paints below it
    // regardless of DOM order, hiding every foreign shape. `.sheet-overlay-svg`
    // (sheet.css) sits at 3 — above the drawing, below the chrome.
    <svg
      data-testid="foreign-overlay"
      role="img"
      aria-label="Claims from other sheets on this board"
      className="sheet-overlay-svg"
    >
      {shapes.map((shape) => {
        const selected = shape.id === selectedId;
        const dimmed =
          !selected &&
          shape.kind === 'edge' &&
          connectionRelation !== null &&
          shape.row.relation !== connectionRelation;
        const stroke = selected
          ? 'var(--region-stroke)'
          : 'var(--foreign-stroke)';
        const strokeWidth = selected ? 2 : 1.5;
        const handlePointerDown = (e: React.PointerEvent) => {
          e.stopPropagation();
          e.preventDefault();
          onSelect(shape.id);
        };

        if (shape.kind === 'region') {
          const r = rectToScreen(shape.rect, viewport, offset);
          return (
            <g key={shape.id}>
              <rect
                data-testid="foreign-shape"
                data-foreign-id={shape.id}
                data-foreign-kind="region"
                x={r.x}
                y={r.y}
                width={r.width}
                height={r.height}
                fill="none"
                stroke={stroke}
                strokeWidth={strokeWidth}
                strokeDasharray="6 4"
                opacity={0.7}
                className="sheet-overlay-hit"
                onPointerDown={handlePointerDown}
              />
              {shape.label && (
                <text
                  x={r.x + 4}
                  y={r.y + 14}
                  fontSize={11}
                  fill={stroke}
                  className="sheet-overlay-static"
                >
                  {shape.label}
                </text>
              )}
            </g>
          );
        }

        const a = sceneToScreen(shape.line[0], viewport, offset);
        const b = sceneToScreen(shape.line[1], viewport, offset);
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        return (
          <g key={shape.id}>
            <line
              data-testid="foreign-shape"
              data-foreign-id={shape.id}
              data-foreign-kind="edge"
              data-relation-dimmed={dimmed || undefined}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke={stroke}
              strokeWidth={strokeWidth}
              strokeDasharray="6 4"
              opacity={dimmed ? 0.12 : 0.7}
              className="sheet-overlay-hit"
              onPointerDown={handlePointerDown}
            />
            {/* Dangling from a vanished foreign region (docs/phases/2-sheet.md
                section 5): a hollow marker at the end whose region claim did
                not come back in this poll — overlay-only, never a scene
                change (screen.ts#foreignShapes). */}
            {shape.danglingStart && (
              <circle
                data-testid="foreign-dangling-marker"
                cx={a.x}
                cy={a.y}
                r={5}
                fill="none"
                stroke={stroke}
                strokeWidth={1.5}
                className="sheet-overlay-static"
              />
            )}
            {shape.danglingEnd && (
              <circle
                data-testid="foreign-dangling-marker"
                cx={b.x}
                cy={b.y}
                r={5}
                fill="none"
                stroke={stroke}
                strokeWidth={1.5}
                className="sheet-overlay-static"
              />
            )}
            {shape.label && (
              <text
                x={mx}
                y={my}
                fontSize={11}
                fill={stroke}
                className="sheet-overlay-static"
              >
                {shape.label}
              </text>
            )}
          </g>
        );
      })}
      {peers.map((p) => {
        const pt = sceneToScreen({ x: p.x, y: p.y }, viewport, offset);
        return (
          <g
            key={p.user}
            data-testid="peer-cursor"
            data-peer-user={p.user}
            data-peer-name={p.name}
            className="sheet-overlay-static"
          >
            {p.rects.map((r) => {
              const rr = rectToScreen(r, viewport, offset);
              return (
                <rect
                  key={`${r.x},${r.y},${r.width},${r.height}`}
                  x={rr.x}
                  y={rr.y}
                  width={rr.width}
                  height={rr.height}
                  fill="none"
                  stroke={p.color}
                  strokeWidth={1.5}
                  opacity={0.35}
                />
              );
            })}
            <circle
              cx={pt.x}
              cy={pt.y}
              r={5}
              fill={p.color}
              stroke="#fff"
              strokeWidth={1.5}
            />
            <text
              x={pt.x + 8}
              y={pt.y - 8}
              fontSize={11}
              fontWeight={600}
              fill={p.color}
              stroke="#fff"
              strokeWidth={3}
              paintOrder="stroke"
            >
              {p.name}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
