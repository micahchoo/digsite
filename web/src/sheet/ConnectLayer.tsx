// Connect in one gesture: a selected image or region shows a handle on a
// side a person can reach (handleSpot); drag it onto another image or region and the connection is
// made where you let go, then named there (RelationPicker). The Edge tool
// still works for people who prefer click, click.
//
// Only the handle takes pointer events. The rest of this layer lets every
// press through to the canvas, so selecting, moving and panning are
// untouched while it is mounted.
import { useRef, useState } from 'react';
import { Icon } from '../components/Icon.tsx';
import { hitAt } from './hit.ts';
import {
  type ElementLike,
  type Point,
  type Viewport,
  rectToScreen,
  sceneToScreen,
  screenToScene,
} from './overlay/screen.ts';

interface Props {
  /** The one selected own image or region, or null (then nothing shows). */
  source: ElementLike | null;
  elements: readonly ElementLike[];
  viewport: Viewport;
  /** Makes the edge; returns its id, or null when it could not be made. */
  connect: (fromId: string, toId: string) => string | null;
  /** The new edge and the screen point to name it at. */
  onConnected: (edgeId: string, at: Point) => void;
}

type Drag = { from: Point; now: Point; targetId: string | null };

const GAP = 14;

/**
 * Where the handle goes: the first side of the image, right, bottom, left,
 * then top, that is inside the canvas area and not under the floating
 * details panel. A handle a person cannot reach is no handle at all.
 */
function handleSpot(
  box: { x: number; y: number; width: number; height: number },
  layer: HTMLElement | null,
): Point {
  const spots: Point[] = [
    { x: box.x + box.width + GAP, y: box.y + box.height / 2 },
    { x: box.x + box.width / 2, y: box.y + box.height + GAP },
    { x: box.x - GAP, y: box.y + box.height / 2 },
    { x: box.x + box.width / 2, y: box.y - GAP },
  ];
  if (!layer) return spots[0] as Point;
  const area = layer.getBoundingClientRect();
  // The details panel floats over the canvas on wide screens.
  const panel = document
    .getElementById('sheet-inspector-panel')
    ?.getBoundingClientRect();
  const free = (p: Point) => {
    const cx = area.left + p.x;
    const cy = area.top + p.y;
    const inArea =
      p.x >= GAP &&
      p.y >= GAP &&
      p.x <= area.width - GAP &&
      p.y <= area.height - GAP;
    const underPanel =
      !!panel &&
      panel.width > 0 &&
      cx >= panel.left - GAP &&
      cx <= panel.right + GAP &&
      cy >= panel.top - GAP &&
      cy <= panel.bottom + GAP;
    return inArea && !underPanel;
  };
  return spots.find(free) ?? (spots[0] as Point);
}

function localPoint(e: React.PointerEvent, layer: Element): Point {
  const box = layer.getBoundingClientRect();
  return { x: e.clientX - box.left, y: e.clientY - box.top };
}

export function ConnectLayer({
  source,
  elements,
  viewport,
  connect,
  onConnected,
}: Props) {
  const [drag, setDrag] = useState<Drag | null>(null);
  // Mounted even with nothing selected, so the first handle after a
  // selection is placed from a real measurement of the layer.
  const layerRef = useRef<HTMLDivElement | null>(null);
  if (!source) {
    return <div ref={layerRef} className="sheet-connect-layer" />;
  }

  const box = rectToScreen(source, viewport);
  const handle = handleSpot(box, layerRef.current);

  function targetAt(p: Point): string | null {
    const hit = hitAt(screenToScene(p, viewport), elements);
    if (!hit || !source || hit.id === source.id) return null;
    return hit.id;
  }

  const target = drag?.targetId
    ? elements.find((e) => e.id === drag.targetId)
    : null;
  const targetBox = target ? rectToScreen(target, viewport) : null;

  return (
    <div
      ref={layerRef}
      className="sheet-connect-layer"
      data-testid="connect-layer"
    >
      {drag && (
        <svg aria-hidden="true" className="sheet-draw-svg">
          {targetBox && (
            <rect
              className="sheet-connect-target"
              x={targetBox.x - 3}
              y={targetBox.y - 3}
              width={targetBox.width + 6}
              height={targetBox.height + 6}
              rx={4}
            />
          )}
          <line
            className="sheet-edge-draft"
            data-testid="connect-draft"
            x1={drag.from.x}
            y1={drag.from.y}
            x2={drag.now.x}
            y2={drag.now.y}
          />
        </svg>
      )}
      <button
        type="button"
        className="sheet-connect-handle"
        data-testid="connect-handle"
        aria-label="Drag to connect this to another image or region"
        title="Drag to connect"
        style={{ left: handle.x, top: handle.y }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          e.currentTarget.setPointerCapture(e.pointerId);
          const layer = e.currentTarget.parentElement;
          if (!layer) return;
          const p = localPoint(e, layer);
          setDrag({ from: handle, now: p, targetId: null });
        }}
        onPointerMove={(e) => {
          if (!drag) return;
          const layer = e.currentTarget.parentElement;
          if (!layer) return;
          const p = localPoint(e, layer);
          setDrag({ ...drag, now: p, targetId: targetAt(p) });
        }}
        onPointerUp={(e) => {
          if (!drag) return;
          e.currentTarget.releasePointerCapture(e.pointerId);
          const targetId = drag.targetId;
          setDrag(null);
          if (!targetId || !source) return;
          const edgeId = connect(source.id, targetId);
          if (!edgeId) return;
          const end = elements.find((el) => el.id === targetId);
          const a = sceneToScreen(
            { x: source.x + source.width / 2, y: source.y + source.height / 2 },
            viewport,
          );
          const b = end
            ? sceneToScreen(
                { x: end.x + end.width / 2, y: end.y + end.height / 2 },
                viewport,
              )
            : drag.now;
          onConnected(edgeId, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
        }}
        onPointerCancel={() => setDrag(null)}
      >
        <Icon name="connect" size={14} />
      </button>
    </div>
  );
}
