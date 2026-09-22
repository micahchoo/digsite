// The foreign layer: an <svg> above the Excalidraw container. pointer-events
// is 'none' on the svg itself and 'all' on each shape, so a click on empty
// canvas falls through to Excalidraw underneath and a click on a foreign
// shape never reaches it — see ../../../.claude/rules/foreign-never-in-scene.md.
import type { Foreign } from '@digsite/shared';
import { useMemo } from 'react';
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
  onSelect: (id: string) => void;
}

export function Overlay({
  rows,
  elements,
  viewport,
  offset,
  selectedId,
  onSelect,
}: Props) {
  const shapes = useMemo(() => foreignShapes(rows, elements), [rows, elements]);

  return (
    <svg
      data-testid="foreign-overlay"
      role="img"
      aria-label="Claims from other sheets on this board"
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        // Excalidraw's own interactive canvas sits at z-index 2
        // (--zIndex-interactiveCanvas); an unset z-index here paints below
        // it regardless of DOM order, hiding every foreign shape. Its
        // toolbar/library UI is --zIndex-layerUI: 4, so 3 sits between the
        // two — above the drawing, below the chrome.
        zIndex: 3,
      }}
    >
      {shapes.map((shape) => {
        const selected = shape.id === selectedId;
        const stroke = selected ? '#1971c2' : '#868e96';
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
                style={{ pointerEvents: 'all', cursor: 'pointer' }}
                onPointerDown={handlePointerDown}
              />
              {shape.label && (
                <text
                  x={r.x + 4}
                  y={r.y + 14}
                  fontSize={11}
                  fill={stroke}
                  style={{ pointerEvents: 'none' }}
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
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke={stroke}
              strokeWidth={strokeWidth}
              strokeDasharray="6 4"
              opacity={0.7}
              style={{ pointerEvents: 'all', cursor: 'pointer' }}
              onPointerDown={handlePointerDown}
            />
            {shape.label && (
              <text
                x={mx}
                y={my}
                fontSize={11}
                fill={stroke}
                style={{ pointerEvents: 'none' }}
              >
                {shape.label}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
