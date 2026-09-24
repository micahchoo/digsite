// The native adapter's one component: a plain `<canvas>`, sized to its
// container with devicePixelRatio, drawn every frame by `render.ts` from
// the sheet's scene (sheet-scene.ts) and this file's viewport.
//
// Its division of labour is:
// `camera.ts` is the arithmetic, `gestures.ts` decides what a pointer press
// means, `scene.ts` is what is on screen and what a point lands on,
// `sheet-scene.ts` holds the elements, the selection and the undo history,
// `images.ts` is the decoded-bitmap cache, `render.ts` draws one frame. This
// file is the seam: DOM events in, `CanvasHandle` out, nothing else.
import { dataOf } from '@digsite/shared';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
} from 'react';
import { usePalette } from '../../../theme/palette.ts';
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
  cursorFor,
  dragBecomes,
  movedEnough,
  pressIntent,
  selectionAfterClick,
  selectionAfterMarquee,
} from './gestures.ts';
import { ImageCache } from './images.ts';
import { renderFrame } from './render.ts';
import {
  type HandleId,
  type Hit,
  buildIndex,
  gripsShown,
  hitAt,
  hitGrip,
  marqueeSelect,
  resizeRegion,
  selectedGroupMembers,
} from './scene.ts';
import { createSheetScene } from './sheet-scene.ts';
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
  function NativeCanvas(
    { files, tool, onChange, dimRelations, captions },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
    const sizeRef = useRef({ width: 0, height: 0, dpr: 1 });

    // The scene tells `sceneChanged` what to redraw and announce; the
    // callback is filled in below, once scheduleRender and emitChange exist.
    const sceneChanged = useRef<(what: { remote: boolean }) => void>(() => {});
    const sceneRef = useRef<ReturnType<typeof createSheetScene> | null>(null);
    if (!sceneRef.current)
      sceneRef.current = createSheetScene((what) => sceneChanged.current(what));
    const scene = sceneRef.current;
    const viewportRef = useRef<Viewport>(ZERO_VIEWPORT);
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
      if (held && held.elements === scene.elements()) return held.index;
      const index = buildIndex(scene.elements());
      indexRef.current = { index, elements: scene.elements() };
      return index;
    }, []);

    const palette = usePalette();
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
        elements: scene.elements(),
        selectedIds: scene.selectedSet(),
        images: imagesRef.current,
        marquee,
        dimRelations,
        captions,
        palette,
      });
    }, [dimRelations, captions, palette]);

    const scheduleRender = useCallback(() => {
      if (rafRef.current !== null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        draw();
      });
    }, [draw]);

    // A new palette (theme change) or emphasis changes the frame, not the scene.
    useEffect(() => {
      scheduleRender();
    }, [scheduleRender]);

    const emitChange = useCallback(() => {
      const change: SceneChange = {
        elements: scene.elements(),
        viewport: viewportRef.current,
        selectedIds: scene.selectedIds(),
      };
      onChangeRef.current(change);
    }, []);
    sceneChanged.current = ({ remote }) => {
      scheduleRender();
      if (!remote) emitChange();
    };

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
      if (scene.selectedSet().size !== 1) return null;
      const [id] = scene.selectedSet();
      const el = scene.elements().find((e) => e.id === id);
      if (!el || el.isDeleted) return null;
      if (dataOf(el)?.kind !== 'region') return null;
      return { x: el.x, y: el.y, width: el.width, height: el.height };
    }, []);

    const setSelection = useCallback(
      (ids: string[]) => scene.select(ids),
      [scene],
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
          regionRect &&
          !forcePan &&
          gripsShown(regionRect, viewportRef.current.zoom)
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
          scene.elements(),
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
            selectedAtStart: scene.selectedIds(),
          };
        }
        if (pending.grip && scene.selectedSet().size === 1) {
          const [regionId] = scene.selectedSet();
          const rect = selectedRegionRect();
          if (regionId && rect) {
            return {
              kind: 'resize',
              origin: scene.elements(),
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
            scene.elements(),
            pending.hit.id,
            scene.selectedIds(),
          );
          return {
            kind: 'move',
            origin: scene.elements(),
            ids,
            startWorld: pending.worldStart,
          };
        }
        return { kind: 'pan', lastScreen: pending.screenStart };
      },
      [selectedRegionRect],
    );

    /** Says with the cursor what a press here would do. Set on the element,
     * not through React, so a hover never re-renders. */
    const showCursor = useCallback(
      (worldPt: Point) => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const mode: Mode = toolRef.current === 'pan' ? 'pan' : 'select';
        const drag = dragRef.current;
        let target: Target = 'empty';
        let grip: string | null = null;
        if (!drag && mode === 'select') {
          const hit = hitAt(
            worldPt,
            scene.elements(),
            viewportRef.current.zoom,
            spatialIndex(),
          );
          target = hit?.kind ?? 'empty';
          const regionRect = selectedRegionRect();
          if (regionRect && gripsShown(regionRect, viewportRef.current.zoom))
            grip = hitGrip(
              worldPt,
              regionRect,
              GRIP_REACH_PX / viewportRef.current.zoom,
            );
        }
        const cursor = cursorFor({
          mode,
          forcePan: spaceHeldRef.current,
          dragging: drag?.kind ?? null,
          target,
          grip: drag?.kind === 'resize' ? drag.handle : grip,
        });
        if (canvas.style.cursor !== cursor) canvas.style.cursor = cursor;
      },
      [selectedRegionRect, spatialIndex],
    );

    const onPointerMove = useCallback(
      (e: React.PointerEvent<HTMLCanvasElement>) => {
        const screenPt = canvasPoint(e.clientX, e.clientY);
        const worldPt = toWorld(viewportRef.current, screenPt.x, screenPt.y);

        if (!dragRef.current) {
          const pending = pendingRef.current;
          if (!pending) {
            showCursor(worldPt);
            return;
          }
          if (!movedEnough(pending.screenStart, screenPt)) return;
          const mode: Mode = toolRef.current === 'pan' ? 'pan' : 'select';
          dragRef.current = beginDrag(pending, mode);
          showCursor(worldPt);
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
          scene.preview(shifted);
          return;
        }
        if (drag.kind === 'resize') {
          const nextRect = resizeRegion(drag.originRect, drag.handle, worldPt);
          const resized = scene
            .elements()
            .map((el) =>
              el.id === drag.regionId ? { ...el, ...nextRect } : el,
            );
          // A region can be an edge's endpoint too — follow it the same
          // way a moved image's edges follow (retargetEdges' own contract).
          scene.preview(resized);
          return;
        }
        if (drag.kind === 'marquee') {
          drag.nowWorld = worldPt;
          scheduleRender();
        }
      },
      [beginDrag, canvasPoint, scheduleRender, emitChange, showCursor],
    );

    const onPointerUp = useCallback(
      (e: React.PointerEvent<HTMLCanvasElement>) => {
        canvasRef.current?.releasePointerCapture(e.pointerId);
        const drag = dragRef.current;
        const pending = pendingRef.current;
        dragRef.current = null;
        pendingRef.current = null;
        {
          const p = canvasPoint(e.clientX, e.clientY);
          showCursor(toWorld(viewportRef.current, p.x, p.y));
        }

        if (drag?.kind === 'move' || drag?.kind === 'resize') {
          scene.commitDrag(drag.origin);
          return;
        }
        if (drag?.kind === 'marquee') {
          const band = rectBetween(drag.startWorld, drag.nowWorld);
          setSelection(
            selectionAfterMarquee(
              drag.selectedAtStart,
              marqueeSelect(scene.elements(), band),
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
              scene.selectedIds(),
              pending.hit?.id ?? null,
              pending.additive,
            ),
          );
        }
      },
      [canvasPoint, emitChange, scheduleRender, setSelection, showCursor],
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
          if (!scene.selectedSet().size) return;
          e.preventDefault();
          handleRef.current?.apply([
            { op: 'remove', ids: scene.selectedIds() },
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
      // `handleRef`/`toolRef`/`sceneRef` are refs, read fresh every
      // call — this effect only ever needs to re-subscribe if `setSelection`
      // itself changed identity, and it never does (its own useCallback has
      // an empty dependency array).
    }, [setSelection]);

    // -- the imperative handle ------------------------------------------------
    useImperativeHandle(ref, (): CanvasHandle => {
      const handle: CanvasHandle = {
        elements: scene.elements,
        apply: scene.apply,
        applyRemote: scene.applyRemote,
        select: scene.select,
        selectedIds: scene.selectedIds,
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
        hitAt(client) {
          const screen = canvasPoint(client.x, client.y);
          const hit = hitAt(
            toWorld(viewportRef.current, screen.x, screen.y),
            scene.elements(),
            viewportRef.current.zoom,
            spatialIndex(),
          );
          return hit ? { id: hit.id, kind: hit.kind } : null;
        },
        zoomToFit(ids) {
          const wanted = ids && new Set(ids);
          const rects = scene
            .elements()
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
        undo: scene.undo,
        redo: scene.redo,
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
