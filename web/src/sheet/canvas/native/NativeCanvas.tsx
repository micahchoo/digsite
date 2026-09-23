// The native adapter's one component: a plain `<canvas>`, sized to its
// container with devicePixelRatio, drawn every frame by `render.ts` from
// this file's own element/viewport/selection state.
//
// Its division of labour is:
// `camera.ts` is the arithmetic, `gestures.ts` decides what a pointer press
// means, `scene.ts` is what is on screen and what a point lands on,
// `history.ts`/`ops.ts` are the undo stack and the patch/build logic,
// `images.ts` is the decoded-bitmap cache, `render.ts` draws one frame. This
// file is the seam: DOM events in, `CanvasHandle` out, nothing else.
import { dataOf, mergeByVersion } from '@digsite/shared';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
} from 'react';
import type {
  CanvasHandle,
  CanvasProps,
  SceneChange,
  SceneElement,
  Viewport,
  WheelInput,
} from '../types.ts';
import {
  fitBox,
  scrollBy,
  toWorld,
  wheelGesture,
  zoomAt,
  zoomBy as zoomByFactor,
} from './camera.ts';
import { type Point, type Rect, boundsOf, rectBetween } from './geometry.ts';
import {
  type Mode,
  type Target,
  dragBecomes,
  movedEnough,
  pressIntent,
  selectionAfterClick,
  selectionAfterMarquee,
} from './gestures.ts';
import { History, applyStep } from './history.ts';
import { ImageCache } from './images.ts';
import { applyPatch, diffForHistory, finalizeDrag } from './ops.ts';
import { renderFrame } from './render.ts';
import {
  type HandleId,
  type Hit,
  buildIndex,
  hitAt,
  hitGrip,
  marqueeSelect,
  resizeRegion,
  retargetEdges,
  selectedGroupMembers,
} from './scene.ts';
import type { SpatialIndex } from './spatial.ts';

const ZERO_VIEWPORT: Viewport = { scrollX: 0, scrollY: 0, zoom: 1 };
const GRIP_REACH_PX = 8;

type Drag =
  | { kind: 'pan'; lastScreen: Point }
  | {
      kind: 'move';
      origin: SceneElement[];
      ids: Set<string>;
      startWorld: Point;
    }
  | {
      kind: 'resize';
      origin: SceneElement[];
      regionId: string;
      handle: HandleId;
      originRect: Rect;
    }
  | {
      kind: 'marquee';
      startWorld: Point;
      nowWorld: Point;
      additive: boolean;
      selectedAtStart: string[];
    };

interface Pending {
  screenStart: Point;
  worldStart: Point;
  forcePan: boolean;
  additive: boolean;
  grip: HandleId | null;
  hit: Hit | null;
  target: Target;
}

/** True while an input/textarea/contenteditable has focus — a copy of
 * `../../Toolbar.tsx`'s own `typing()`, kept local since that one is not
 * exported and this file must not reach across the seam for it. */
function typing(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    (el as HTMLElement).isContentEditable === true
  );
}

export const NativeCanvas = forwardRef<CanvasHandle, CanvasProps>(
  function NativeCanvas({ files, tool, onChange, dimRelations }, ref) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
    const sizeRef = useRef({ width: 0, height: 0, dpr: 1 });

    const elementsRef = useRef<SceneElement[]>([]);
    const viewportRef = useRef<Viewport>(ZERO_VIEWPORT);
    const selectedIdsRef = useRef<Set<string>>(new Set());
    const historyRef = useRef(new History());
    const imagesRef = useRef(new ImageCache());
    const indexRef = useRef<{
      index: SpatialIndex;
      elements: SceneElement[];
    } | null>(null);

    const toolRef = useRef(tool);
    toolRef.current = tool;
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;

    const pendingRef = useRef<Pending | null>(null);
    const dragRef = useRef<Drag | null>(null);
    const spaceHeldRef = useRef(false);
    const rafRef = useRef<number | null>(null);
    // The latest imperative handle, so DOM-event listeners set up once
    // (the keyboard effect below) can still reach `undo`/`redo`/`apply`
    // without depending on `useImperativeHandle`'s factory identity.
    const handleRef = useRef<CanvasHandle | null>(null);

    const spatialIndex = useCallback((): SpatialIndex => {
      const held = indexRef.current;
      if (held && held.elements === elementsRef.current) return held.index;
      const index = buildIndex(elementsRef.current);
      indexRef.current = { index, elements: elementsRef.current };
      return index;
    }, []);

    const draw = useCallback(() => {
      const ctx = ctxRef.current;
      if (!ctx) return;
      const { width, height } = sizeRef.current;
      const drag = dragRef.current;
      const marquee =
        drag?.kind === 'marquee'
          ? rectBetween(drag.startWorld, drag.nowWorld)
          : null;
      renderFrame({
        ctx,
        width,
        height,
        viewport: viewportRef.current,
        elements: elementsRef.current,
        selectedIds: selectedIdsRef.current,
        images: imagesRef.current,
        marquee,
        dimRelations,
      });
    }, [dimRelations]);

    const scheduleRender = useCallback(() => {
      if (rafRef.current !== null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        draw();
      });
    }, [draw]);

    const emitChange = useCallback(() => {
      const change: SceneChange = {
        elements: elementsRef.current,
        viewport: viewportRef.current,
        selectedIds: [...selectedIdsRef.current],
      };
      onChangeRef.current(change);
    }, []);

    // -- sizing -----------------------------------------------------------
    useEffect(() => {
      const container = containerRef.current;
      const canvas = canvasRef.current;
      if (!container || !canvas) return;
      const resize = () => {
        const box = container.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const width = Math.max(1, Math.round(box.width));
        const height = Math.max(1, Math.round(box.height));
        // Sizing a canvas clears it (../../../../.claude/rules/image-graph-atlas-tiles.md) —
        // fine here, every frame is drawn from scratch, never incrementally.
        if (
          sizeRef.current.width !== width ||
          sizeRef.current.height !== height ||
          sizeRef.current.dpr !== dpr
        ) {
          canvas.width = Math.max(1, Math.round(width * dpr));
          canvas.height = Math.max(1, Math.round(height * dpr));
          canvas.style.width = `${width}px`;
          canvas.style.height = `${height}px`;
          sizeRef.current = { width, height, dpr };
          const ctx = canvas.getContext('2d');
          ctxRef.current = ctx;
          ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
          scheduleRender();
        }
      };
      resize();
      const observer = new ResizeObserver(resize);
      observer.observe(container);
      return () => observer.disconnect();
    }, [scheduleRender]);

    // -- images -------------------------------------------------------------
    useEffect(() => {
      imagesRef.current.sync(files, scheduleRender);
    }, [files, scheduleRender]);

    // -- coordinate helpers ---------------------------------------------------
    const canvasPoint = useCallback(
      (clientX: number, clientY: number): Point => {
        const box = canvasRef.current?.getBoundingClientRect();
        return { x: clientX - (box?.left ?? 0), y: clientY - (box?.top ?? 0) };
      },
      [],
    );

    const selectedRegionRect = useCallback((): Rect | null => {
      if (selectedIdsRef.current.size !== 1) return null;
      const [id] = selectedIdsRef.current;
      const el = elementsRef.current.find((e) => e.id === id);
      if (!el || el.isDeleted) return null;
      if (dataOf(el)?.kind !== 'region') return null;
      return { x: el.x, y: el.y, width: el.width, height: el.height };
    }, []);

    const setSelection = useCallback(
      (ids: string[]) => {
        selectedIdsRef.current = new Set(ids);
        scheduleRender();
        emitChange();
      },
      [scheduleRender, emitChange],
    );

    // -- pointer handling (select/pan only — DrawLayer.tsx owns region/edge) --
    const onPointerDown = useCallback(
      (e: React.PointerEvent<HTMLCanvasElement>) => {
        if (toolRef.current !== 'select' && toolRef.current !== 'pan') return;
        canvasRef.current?.setPointerCapture(e.pointerId);
        const screenPt = canvasPoint(e.clientX, e.clientY);
        const worldPt = toWorld(viewportRef.current, screenPt.x, screenPt.y);
        const forcePan = spaceHeldRef.current || e.button === 1;
        const regionRect = selectedRegionRect();
        const grip =
          regionRect && !forcePan
            ? hitGrip(
                worldPt,
                regionRect,
                GRIP_REACH_PX / viewportRef.current.zoom,
              )
            : null;
        const mode: Mode = toolRef.current === 'pan' ? 'pan' : 'select';
        const intent = pressIntent({
          mode,
          forcePan,
          button: e.button,
          onGrip: !!grip,
        });
        const hit = hitAt(
          worldPt,
          elementsRef.current,
          viewportRef.current.zoom,
          spatialIndex(),
        );
        const target: Target = hit ? hit.kind : 'empty';
        pendingRef.current = {
          screenStart: screenPt,
          worldStart: worldPt,
          forcePan,
          additive: e.shiftKey,
          grip: intent === 'handle' && !e.shiftKey ? grip : null,
          hit,
          target,
        };
      },
      [canvasPoint, selectedRegionRect, spatialIndex],
    );

    const beginDrag = useCallback(
      (pending: Pending, mode: Mode): Drag => {
        if (pending.additive && !pending.forcePan) {
          return {
            kind: 'marquee',
            startWorld: pending.worldStart,
            nowWorld: pending.worldStart,
            additive: true,
            selectedAtStart: [...selectedIdsRef.current],
          };
        }
        if (pending.grip && selectedIdsRef.current.size === 1) {
          const [regionId] = selectedIdsRef.current;
          const rect = selectedRegionRect();
          if (regionId && rect) {
            return {
              kind: 'resize',
              origin: elementsRef.current,
              regionId,
              handle: pending.grip,
              originRect: rect,
            };
          }
        }
        const decided = dragBecomes({
          forcePan: pending.forcePan,
          over: pending.target,
          mode,
        });
        if (decided === 'pan')
          return { kind: 'pan', lastScreen: pending.screenStart };
        if (decided === 'move' && pending.hit) {
          const ids = selectedGroupMembers(
            elementsRef.current,
            pending.hit.id,
            [...selectedIdsRef.current],
          );
          return {
            kind: 'move',
            origin: elementsRef.current,
            ids,
            startWorld: pending.worldStart,
          };
        }
        return { kind: 'pan', lastScreen: pending.screenStart };
      },
      [selectedRegionRect],
    );

    const onPointerMove = useCallback(
      (e: React.PointerEvent<HTMLCanvasElement>) => {
        const screenPt = canvasPoint(e.clientX, e.clientY);
        const worldPt = toWorld(viewportRef.current, screenPt.x, screenPt.y);

        if (!dragRef.current) {
          const pending = pendingRef.current;
          if (!pending) return;
          if (!movedEnough(pending.screenStart, screenPt)) return;
          const mode: Mode = toolRef.current === 'pan' ? 'pan' : 'select';
          dragRef.current = beginDrag(pending, mode);
        }

        const drag = dragRef.current;
        if (!drag) return;

        if (drag.kind === 'pan') {
          const dx = screenPt.x - drag.lastScreen.x;
          const dy = screenPt.y - drag.lastScreen.y;
          drag.lastScreen = screenPt;
          viewportRef.current = scrollBy(viewportRef.current, dx, dy);
          scheduleRender();
          emitChange();
          return;
        }
        if (drag.kind === 'move') {
          const dx = worldPt.x - drag.startWorld.x;
          const dy = worldPt.y - drag.startWorld.y;
          const shifted = drag.origin.map((el) =>
            drag.ids.has(el.id) ? { ...el, x: el.x + dx, y: el.y + dy } : el,
          );
          elementsRef.current = retargetEdges(shifted);
          scheduleRender();
          emitChange();
          return;
        }
        if (drag.kind === 'resize') {
          const nextRect = resizeRegion(drag.originRect, drag.handle, worldPt);
          const resized = elementsRef.current.map((el) =>
            el.id === drag.regionId ? { ...el, ...nextRect } : el,
          );
          // A region can be an edge's endpoint too — follow it the same
          // way a moved image's edges follow (retargetEdges' own contract).
          elementsRef.current = retargetEdges(resized);
          scheduleRender();
          emitChange();
          return;
        }
        if (drag.kind === 'marquee') {
          drag.nowWorld = worldPt;
          scheduleRender();
        }
      },
      [beginDrag, canvasPoint, scheduleRender, emitChange],
    );

    const onPointerUp = useCallback(
      (e: React.PointerEvent<HTMLCanvasElement>) => {
        canvasRef.current?.releasePointerCapture(e.pointerId);
        const drag = dragRef.current;
        const pending = pendingRef.current;
        dragRef.current = null;
        pendingRef.current = null;

        if (drag?.kind === 'move' || drag?.kind === 'resize') {
          const { elements, entries } = finalizeDrag(
            drag.origin,
            elementsRef.current,
          );
          if (entries.length) historyRef.current.push({ entries });
          elementsRef.current = elements;
          scheduleRender();
          emitChange();
          return;
        }
        if (drag?.kind === 'marquee') {
          const band = rectBetween(drag.startWorld, drag.nowWorld);
          setSelection(
            selectionAfterMarquee(
              drag.selectedAtStart,
              marqueeSelect(elementsRef.current, band),
              drag.additive,
            ),
          );
          return;
        }
        if (drag?.kind === 'pan') return; // nothing to commit

        // A plain click (never crossed the drag threshold): select or clear.
        if (pending) {
          setSelection(
            selectionAfterClick(
              [...selectedIdsRef.current],
              pending.hit?.id ?? null,
              pending.additive,
            ),
          );
        }
      },
      [emitChange, scheduleRender, setSelection],
    );

    const applyWheel = useCallback(
      (input: WheelInput, pt: Point) => {
        const gesture = wheelGesture(input, sizeRef.current.height);
        if (gesture.kind === 'zoom') {
          viewportRef.current = zoomAt(viewportRef.current, gesture.factor, pt);
        } else {
          // Wheel deltas point AWAY from the content (scrolling down reveals
          // what is below, i.e. the content moves up) — the negation is
          // `scrollBy`'s "content follows the pointer" contract read
          // backwards for a wheel rather than a drag.
          viewportRef.current = scrollBy(
            viewportRef.current,
            -gesture.dx,
            -gesture.dy,
          );
        }
        scheduleRender();
        emitChange();
      },
      [scheduleRender, emitChange],
    );

    const onWheel = useCallback(
      (e: React.WheelEvent<HTMLCanvasElement>) => {
        e.preventDefault();
        applyWheel(
          {
            deltaX: e.deltaX,
            deltaY: e.deltaY,
            deltaMode: e.deltaMode,
            ctrlKey: e.ctrlKey,
            metaKey: e.metaKey,
            shiftKey: e.shiftKey,
          },
          canvasPoint(e.clientX, e.clientY),
        );
      },
      [applyWheel, canvasPoint],
    );

    // -- keyboard: space-pan, Delete, Cmd/Ctrl+Z, Shift+Cmd/Ctrl+Z -----------
    useEffect(() => {
      function onKeyDown(e: KeyboardEvent) {
        if (typing()) return;
        if (e.code === 'Space' && !spaceHeldRef.current) {
          spaceHeldRef.current = true;
          return;
        }
        const meta = e.metaKey || e.ctrlKey;
        if (meta && e.key.toLowerCase() === 'z') {
          e.preventDefault();
          if (e.shiftKey) handleRef.current?.redo();
          else handleRef.current?.undo();
          return;
        }
        if (
          (e.key === 'Delete' || e.key === 'Backspace') &&
          toolRef.current === 'select'
        ) {
          if (!selectedIdsRef.current.size) return;
          e.preventDefault();
          handleRef.current?.apply([
            { op: 'remove', ids: [...selectedIdsRef.current] },
          ]);
          setSelection([]);
        }
      }
      function onKeyUp(e: KeyboardEvent) {
        if (e.code === 'Space') spaceHeldRef.current = false;
      }
      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('keyup', onKeyUp);
      return () => {
        window.removeEventListener('keydown', onKeyDown);
        window.removeEventListener('keyup', onKeyUp);
      };
      // `handleRef`/`toolRef`/`selectedIdsRef` are refs, read fresh every
      // call — this effect only ever needs to re-subscribe if `setSelection`
      // itself changed identity, and it never does (its own useCallback has
      // an empty dependency array).
    }, [setSelection]);

    // -- the imperative handle ------------------------------------------------
    useImperativeHandle(ref, (): CanvasHandle => {
      const handle: CanvasHandle = {
        elements() {
          return elementsRef.current;
        },
        apply(patch, opts) {
          const built = retargetEdges(applyPatch(patch, elementsRef.current));
          if (opts?.history !== false) {
            const entries = diffForHistory(elementsRef.current, built);
            if (entries.length) historyRef.current.push({ entries });
          }
          elementsRef.current = built;
          scheduleRender();
          emitChange();
        },
        applyRemote(raw) {
          // No `onChange` here on purpose: `room.ts` calls this and then
          // re-reads `elements()`/`viewport()` itself for its own state,
          // Programmatic updates do not emit onChange; the owner re-reads
          // state through this handle after applying the update.
          elementsRef.current = mergeByVersion(
            elementsRef.current,
            raw as SceneElement[],
          );
          const live = new Set(
            elementsRef.current.filter((e) => !e.isDeleted).map((e) => e.id),
          );
          selectedIdsRef.current = new Set(
            [...selectedIdsRef.current].filter((id) => live.has(id)),
          );
          scheduleRender();
        },
        select(ids) {
          const live = new Set(
            elementsRef.current.filter((e) => !e.isDeleted).map((e) => e.id),
          );
          setSelection(ids.filter((id) => live.has(id)));
        },
        selectedIds() {
          return [...selectedIdsRef.current];
        },
        viewport() {
          return { ...viewportRef.current };
        },
        setViewport(v) {
          viewportRef.current = {
            scrollX: v.scrollX ?? viewportRef.current.scrollX,
            scrollY: v.scrollY ?? viewportRef.current.scrollY,
            zoom: v.zoom ?? viewportRef.current.zoom,
          };
          scheduleRender();
          emitChange();
        },
        wheel(input, point) {
          applyWheel(input, point);
        },
        zoomToFit(ids) {
          const wanted = ids && new Set(ids);
          const rects = elementsRef.current
            .filter((e) => !e.isDeleted && (!wanted || wanted.has(e.id)))
            .map((e) => ({ x: e.x, y: e.y, width: e.width, height: e.height }));
          const box = boundsOf(rects);
          if (!box) return;
          const { width, height } = sizeRef.current;
          viewportRef.current = fitBox(box, width, height, viewportRef.current);
          scheduleRender();
          emitChange();
        },
        zoomBy(factor) {
          const { width, height } = sizeRef.current;
          viewportRef.current = zoomByFactor(
            viewportRef.current,
            factor,
            width / 2,
            height / 2,
          );
          scheduleRender();
          emitChange();
        },
        undo() {
          const step = historyRef.current.undo();
          if (!step) return;
          elementsRef.current = applyStep(elementsRef.current, step, 'undo');
          scheduleRender();
          emitChange();
        },
        redo() {
          const step = historyRef.current.redo();
          if (!step) return;
          elementsRef.current = applyStep(elementsRef.current, step, 'redo');
          scheduleRender();
          emitChange();
        },
      };
      handleRef.current = handle;
      return handle;
    });

    return (
      <div
        ref={containerRef}
        className="digsite-canvas digsite-canvas-native"
        style={{ position: 'absolute', inset: 0 }}
      >
        <canvas
          ref={canvasRef}
          style={{
            display: 'block',
            width: '100%',
            height: '100%',
            cursor: tool === 'pan' ? 'grab' : 'default',
            touchAction: 'none',
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onWheel={onWheel}
        />
      </div>
    );
  },
);
