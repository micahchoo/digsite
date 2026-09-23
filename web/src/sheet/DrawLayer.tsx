// The region and edge tools' pointer handling (docs/phases/2-sheet.md
// section 1). A full-bleed sibling layer, `pointer-events` 'all' only while
// the active tool is 'region' or 'edge' — 'select' and 'pan' use the canvas
// interaction path, so this layer gets out of the way.
//
// What a press means is decided once, by `pointerIntent` (gestures.ts) —
// this component turns a DOM PointerEvent into a scene point
// (`screenToScene`) and a hit (`hitAt`), asks `pointerIntent`, and acts on
// the answer. It never re-decides the question itself.
//
// Region: press on an image starts a drag; a live rectangle follows the
// pointer; release commits it through `tools.pointerDraw` (scene
// coordinates, the same entry point the test hook and smoke script use) and
// opens our small text input over the new region for the label. The canvas
// seam's imperative handle has
// no "start editing this bound text" call; the alternatives were
// `setActiveTool({type:'text'})` (steals the *tool*, not just this element)
// or simulating a double-click on the container (brittle, and re-enters
// canvas text-fit behavior that drawRegion avoids — see tools.ts#drawRegion).
// A floating input is a few lines, reliable,
// and commits through the existing `setProperty(id, 'label', value)` path,
// so a typed label is truncated for display exactly like an Inspector edit.
//
// Edge: press on an image or own region with no pending source sets it
// (`pointerIntent` -> 'edge-source'); a preview line follows the pointer to
// the next press, which completes it (-> 'edge-target') through
// `tools.connect`. Escape cancels the pending source.
import type { VocabularyTerm } from '@digsite/shared';
import { useEffect, useRef, useState } from 'react';
import { TermInput } from '../components/TermInput.tsx';
import type { WheelInput } from './canvas/types.ts';
import {
  type Point,
  type Target,
  type Tool,
  movedEnough,
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
import { nextImage } from './reading-order.ts';
import type { Tools } from './tools.ts';

interface Props {
  tool: Tool;
  tools: Tools;
  elements: readonly ElementLike[];
  viewport: Viewport;
  offset: ContainerOffset;
  onPendingEdgeChange: (pending: boolean) => void;
  onDrawn: () => void;
  /** A connection made with the Edge tool, and where to name it. */
  onEdgeDrawn: (edgeId: string, at: Point) => void;
  /** The board's labels, for the new region's label field. */
  labelTerms: readonly VocabularyTerm[];
  /** Labels the board already uses that fit this picture, best first
   * (CONTEXT.md "Label suggestion"); [] when there are none or it is off. */
  suggestLabels?: (imageId: string) => Promise<string[]>;
  onPan: (dx: number, dy: number) => void;
  onWheel: (input: WheelInput, point: Point) => void;
}

type Drag = { start: Point; imageId: string } | null;
type EdgePending = { elId: string; anchor: Point } | null;
type FallbackPointer = {
  start: Point;
  last: Point;
  hitId: string | null;
  forcePan: boolean;
  panning: boolean;
};

function clientPoint(e: {
  currentTarget: Element;
  clientX: number;
  clientY: number;
}): Point {
  const target = e.currentTarget.getBoundingClientRect();
  return { x: e.clientX - target.left, y: e.clientY - target.top };
}

function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return Boolean(
    element &&
      (element.tagName === 'INPUT' ||
        element.tagName === 'TEXTAREA' ||
        element.isContentEditable),
  );
}

export function DrawLayer({
  tool,
  tools,
  elements,
  viewport,
  offset,
  onPendingEdgeChange,
  onDrawn,
  onEdgeDrawn,
  labelTerms,
  onPan,
  onWheel,
  suggestLabels,
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
  const [suggested, setSuggested] = useState<string[]>([]);
  /** The region the label box is open for, as the suggestions see it. */
  const labelIdRef = useRef<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const fallbackRef = useRef<FallbackPointer | null>(null);
  const spaceHeldRef = useRef(false);
  // The keyboard loop: the image the last region went on, and what Tab
  // needs to read at the moment it is pressed.
  const currentImageRef = useRef<string | null>(null);
  const loopRef = useRef({ tool, elements, tools, labelOpen: false });
  loopRef.current = { tool, elements, tools, labelOpen: labelFor !== null };

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
      if (e.code === 'Space' && !isTypingTarget(e.target))
        spaceHeldRef.current = true;
      // Region tool: Tab moves to the next image, Shift+Tab to the previous.
      const loop = loopRef.current;
      if (
        e.key === 'Tab' &&
        loop.tool === 'region' &&
        !loop.labelOpen &&
        !isTypingTarget(e.target)
      ) {
        const next = nextImage(
          loop.elements,
          currentImageRef.current,
          e.shiftKey ? -1 : 1,
        );
        if (next) {
          e.preventDefault();
          currentImageRef.current = next.id;
          loop.tools.zoomToFit([next.id]);
        }
        return;
      }
      if (e.key !== 'Escape') return;
      setEdgePending(null);
      setDrag(null);
      setDragNow(null);
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.code === 'Space') spaceHeldRef.current = false;
    }
    function onBlur() {
      spaceHeldRef.current = false;
      fallbackRef.current = null;
    }
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  if (tool !== 'region' && tool !== 'edge') return null;

  function toScene(e: React.PointerEvent): Point {
    return screenToScene(clientPoint(e), viewport, offset);
  }

  function handlePointerDown(e: React.PointerEvent) {
    if (isTypingTarget(e.target)) return;
    const p = toScene(e);
    const hit = hitAt(p, elements);
    const target: Target = hit ? hit.kind : 'empty';
    const intent = pointerIntent({
      tool,
      target,
      pendingSource: !!edgePending,
      forcePan: e.button === 1 || spaceHeldRef.current,
    });

    if (intent === 'native' || intent === 'pan') {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      const screen = clientPoint(e);
      fallbackRef.current = {
        start: screen,
        last: screen,
        hitId: hit?.id ?? null,
        forcePan: intent === 'pan',
        panning: false,
      };
      return;
    }

    if (intent === 'draw-region') {
      if (!hit) return; // narrows for TS; pointerIntent guarantees target === 'image' here
      currentImageRef.current = hit.id;
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
    const from = sceneToScreen(edgePending.anchor, viewport, offset);
    setEdgePending(null);
    if (!newId) return;
    onDrawn();
    const to = clientPoint(e);
    onEdgeDrawn(newId, { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 });
  }

  function handlePointerMove(e: React.PointerEvent) {
    const fallback = fallbackRef.current;
    if (fallback) {
      const screen = clientPoint(e);
      if (!fallback.panning && movedEnough(fallback.start, screen))
        fallback.panning = true;
      if (fallback.panning) {
        onPan(screen.x - fallback.last.x, screen.y - fallback.last.y);
        fallback.last = screen;
      }
    } else if (drag) setDragNow(toScene(e));
    else if (edgePending) setPointerNow(toScene(e));
  }

  function handlePointerUp(e: React.PointerEvent) {
    const fallback = fallbackRef.current;
    if (fallback) {
      fallbackRef.current = null;
      e.currentTarget.releasePointerCapture(e.pointerId);
      if (!fallback.panning && !fallback.forcePan)
        tools.select(fallback.hitId ?? '');
      return;
    }
    if (!drag) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
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
    // Suggestions arrive when they arrive; the box never waits for them,
    // and a late answer for an earlier region is dropped.
    setSuggested([]);
    labelIdRef.current = id;
    void suggestLabels?.(drag.imageId).then((terms) => {
      if (labelIdRef.current === id) setSuggested(terms);
    });
  }

  function handleWheel(e: React.WheelEvent<HTMLDivElement>) {
    e.preventDefault();
    onWheel(
      {
        deltaX: e.deltaX,
        deltaY: e.deltaY,
        deltaMode: e.deltaMode,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        shiftKey: e.shiftKey,
      },
      clientPoint(e),
    );
  }

  function commitLabel(value = labelValue) {
    if (labelFor) tools.setProperty(labelFor.id, 'label', value.trim());
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
    // above the canvas, below product controls.
    <div
      data-testid="draw-layer"
      className="sheet-draw-layer"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onWheel={handleWheel}
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
        <TermInput
          ref={inputRef}
          aria-label="Region label"
          data-testid="region-label-input"
          className="sheet-label-input"
          placeholder="Label this region…"
          value={labelValue}
          terms={labelTerms}
          onChange={setLabelValue}
          onCommit={commitLabel}
          onCancel={() => setLabelFor(null)}
          onBlur={() => {
            if (labelFor) commitLabel();
          }}
          // Dynamic per-instance position/size only — every static rule
          // (position, font, z-index) lives in sheet.css's `.sheet-label-input`.
          style={{
            left: labelFor.screenRect.x,
            top: labelFor.screenRect.y + labelFor.screenRect.height + 4,
            width: Math.max(180, labelFor.screenRect.width),
          }}
        />
      )}
      {labelFor && suggested.length > 0 && (
        <div
          className="sheet-label-suggestions"
          data-testid="label-suggestions"
          style={{
            left: labelFor.screenRect.x,
            top: Math.max(4, labelFor.screenRect.y - 34),
          }}
        >
          <span>Suggested:</span>
          {suggested.map((term) => (
            <button
              key={term}
              type="button"
              data-testid="label-suggestion"
              // Not a press on the canvas: the layer would start a region
              // drag and capture the pointer, so the click never came here.
              onPointerDown={(e) => e.stopPropagation()}
              // Keep the label box focused: a blur would commit it.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setLabelValue(term);
                inputRef.current?.focus();
              }}
            >
              {term}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
