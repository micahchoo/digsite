// The region and edge tools' own pointer handling (docs/phases/2-sheet.md
// section 1). A full-bleed sibling of Excalidraw's canvas, `pointer-events`
// 'all' only while the active tool is 'region' or 'edge' — 'select' and
// 'pan' are Excalidraw's own tools (`pointerIntent` in gestures.ts answers
// 'native' for both) and this layer gets out of the way entirely so it
// never shadows Excalidraw's default drag-select/hand-pan.
//
// What a press means is decided once, by `pointerIntent` (gestures.ts) —
// this component turns a DOM PointerEvent into a scene point
// (`screenToScene`) and a hit (`hitAt`), asks `pointerIntent`, and acts on
// the answer. It never re-decides the question itself.
//
// Region: press on an image starts a drag; a live rectangle follows the
// pointer; release commits it through `tools.pointerDraw` (scene
// coordinates, the same entry point the test hook and smoke script use) and
// opens OUR OWN small text input over the new region for the label — not
// Excalidraw's bound-text editor. The canvas seam's imperative handle has
// no "start editing this bound text" call; the alternatives were
// `setActiveTool({type:'text'})` (steals the *tool*, not just this element)
// or simulating a double-click on the container (brittle, and re-enters
// Excalidraw's own text-fit machinery that drawRegion already works around
// — see tools.ts#drawRegion). A floating input is a few lines, reliable,
// and commits through the existing `setProperty(id, 'label', value)` path,
// so a typed label is truncated for display exactly like an Inspector edit.
//
// Edge: press on an image or own region with no pending source sets it
// (`pointerIntent` -> 'edge-source'); a preview line follows the pointer to
// the next press, which completes it (-> 'edge-target') through
// `tools.connect`. Escape cancels the pending source.
import { useEffect, useRef, useState } from 'react';
import {
  type Point,
  type Target,
  type Tool,
  pointerIntent,
  rectFromDrag,
} from './gestures.ts';
import { hitAt } from './hit.ts';
import type {
  ContainerOffset,
  ElementLike,
  Viewport,
} from './overlay/screen.ts';
import {
  rectToScreen,
  sceneToScreen,
  screenToScene,
} from './overlay/screen.ts';
import type { Tools } from './tools.ts';

interface Props {
  tool: Tool;
  tools: Tools;
  elements: readonly ElementLike[];
  viewport: Viewport;
  offset: ContainerOffset;
  onPendingEdgeChange: (pending: boolean) => void;
  onDrawn: () => void;
}

type Drag = { start: Point; imageId: string } | null;
type EdgePending = { elId: string; anchor: Point } | null;

function clientPoint(e: React.PointerEvent): Point {
  const target = e.currentTarget.getBoundingClientRect();
  return { x: e.clientX - target.left, y: e.clientY - target.top };
}

export function DrawLayer({
  tool,
  tools,
  elements,
  viewport,
  offset,
  onPendingEdgeChange,
  onDrawn,
}: Props) {
  const [drag, setDrag] = useState<Drag>(null);
  const [dragNow, setDragNow] = useState<Point | null>(null);
  const [edgePending, setEdgePending] = useState<EdgePending>(null);
  const [pointerNow, setPointerNow] = useState<Point | null>(null);
  const [labelFor, setLabelFor] = useState<{
    id: string;
    screenRect: { x: number; y: number; width: number; height: number };
  } | null>(null);
  const [labelValue, setLabelValue] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(
    () => onPendingEdgeChange(!!edgePending),
    [edgePending, onPendingEdgeChange],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally re-runs on tool change, to drop an in-progress draft/pending pick — `tool` itself isn't read in the body
  useEffect(() => {
    setDrag(null);
    setDragNow(null);
    setEdgePending(null);
  }, [tool]);

  useEffect(() => {
    if (labelFor) inputRef.current?.focus();
  }, [labelFor]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      setEdgePending(null);
      setDrag(null);
      setDragNow(null);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  if (tool !== 'region' && tool !== 'edge') return null;

  function toScene(e: React.PointerEvent): Point {
    return screenToScene(clientPoint(e), viewport, offset);
  }

  function handlePointerDown(e: React.PointerEvent) {
    const p = toScene(e);
    const hit = hitAt(p, elements);
    const target: Target = hit ? hit.kind : 'empty';
    const intent = pointerIntent({
      tool,
      target,
      pendingSource: !!edgePending,
    });

    if (intent === 'native') return; // pointerIntent already decided this press isn't ours

    if (intent === 'draw-region') {
      if (!hit) return; // narrows for TS; pointerIntent guarantees target === 'image' here
      // Without capture, a drag that leaves this div's bounds (past a
      // window edge, over the Inspector sidebar) stops getting move/up
      // events here at all — the drag state sticks and the tool goes
      // unresponsive until Escape. Capture keeps every event routed here
      // regardless of where the pointer physically travels.
      e.currentTarget.setPointerCapture(e.pointerId);
      setDrag({ start: p, imageId: hit.imageId });
      setDragNow(p);
      return;
    }

    if (intent === 'edge-source') {
      if (!hit) return;
      setEdgePending({ elId: hit.id, anchor: p });
      setPointerNow(p);
      return;
    }

    // intent === 'edge-target'
    if (!hit || !edgePending) return;
    if (hit.id === edgePending.elId) return; // same element: not a self-edge
    const newId = tools.connect(edgePending.elId, hit.id);
    setEdgePending(null);
    if (newId) onDrawn();
  }

  function handlePointerMove(e: React.PointerEvent) {
    if (drag) setDragNow(toScene(e));
    else if (edgePending) setPointerNow(toScene(e));
  }

  function handlePointerUp(e: React.PointerEvent) {
    if (!drag) return;
    const end = toScene(e);
    setDrag(null);
    setDragNow(null);
    const rect = rectFromDrag(drag.start, end);
    if (rect.width < 2 || rect.height < 2) return; // a click, not a drag: no region
    const id = tools.pointerDraw(drag.start.x, drag.start.y, end.x, end.y);
    if (!id) return;
    onDrawn();
    const created = tools.getElements().find((el) => el.id === id);
    if (!created) return;
    const screenRect = rectToScreen(
      {
        x: created.x,
        y: created.y,
        width: created.width,
        height: created.height,
      },
      viewport,
      offset,
    );
    setLabelValue('');
    setLabelFor({ id, screenRect });
  }

  function commitLabel() {
    if (labelFor) tools.setProperty(labelFor.id, 'label', labelValue);
    setLabelFor(null);
  }

  const previewRect =
    drag && dragNow ? rectFromDrag(drag.start, dragNow) : null;
  const previewScreen = previewRect
    ? rectToScreen(
        {
          x: previewRect.x,
          y: previewRect.y,
          width: previewRect.width,
          height: previewRect.height,
        },
        viewport,
        offset,
      )
    : null;

  const edgeLine =
    edgePending && pointerNow
      ? {
          a: sceneToScreen(edgePending.anchor, viewport, offset),
          b: sceneToScreen(pointerNow, viewport, offset),
        }
      : null;

  return (
    // Same layer as the foreign overlay (sheet.css's z-index) — both sit
    // above Excalidraw's canvas, below its chrome.
    <div
      data-testid="draw-layer"
      className="sheet-draw-layer"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    >
      <svg aria-hidden="true" className="sheet-draw-svg">
        {previewScreen && (
          <rect
            data-testid="region-draft"
            x={previewScreen.x}
            y={previewScreen.y}
            width={previewScreen.width}
            height={previewScreen.height}
            className="sheet-region-draft"
          />
        )}
        {edgeLine && (
          <line
            data-testid="edge-draft"
            x1={edgeLine.a.x}
            y1={edgeLine.a.y}
            x2={edgeLine.b.x}
            y2={edgeLine.b.y}
            className="sheet-edge-draft"
          />
        )}
      </svg>
      {labelFor && (
        <input
          ref={inputRef}
          data-testid="region-label-input"
          className="sheet-label-input"
          value={labelValue}
          onChange={(e) => setLabelValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitLabel();
            if (e.key === 'Escape') setLabelFor(null);
          }}
          onBlur={commitLabel}
          // Dynamic per-instance position/size only — every static rule
          // (position, font, z-index) lives in sheet.css's `.sheet-label-input`.
          style={{
            left: labelFor.screenRect.x,
            top: labelFor.screenRect.y + labelFor.screenRect.height + 2,
            width: Math.max(80, labelFor.screenRect.width),
          }}
        />
      )}
    </div>
  );
}
