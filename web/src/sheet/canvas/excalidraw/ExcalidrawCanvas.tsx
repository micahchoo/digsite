// The one component that mounts Excalidraw — the `excalidraw` adapter behind
// `canvas/Canvas.tsx`'s switch (`VITE_CANVAS`/`?canvas=`). Everything behind
// `CanvasHandle` lives here or in `convert.ts`; nothing else in the app
// imports `@excalidraw/*` (../../../../.claude/rules/sheet-canvas-seam.md —
// enforced by `bun run lint:seams`).
//
// Stock chrome, 0.18.1 (checked against the installed package's own
// `dist/types/excalidraw/types.d.ts` — the newer `ui={false}` flag some
// docs describe does not exist on this version's `ExcalidrawProps`):
// `UIOptions.canvasActions` all false and `tools.image: false` turn off
// every command in the main menu and the image tool; `<MainMenu />` with no
// children replaces Excalidraw's own default items with none. Nothing else
// in `UIOptions` reaches the shapes toolbar, the selected-shape "properties"
// island, the footer (zoom/undo/help) or the library/menu TRIGGER buttons in
// this version — `canvas.css` hides those by class name, the one CSS
// override this seam allows (see its own header comment). No `<WelcomeScreen>`
// child is rendered, so its tunnel has nothing piped into it and the welcome
// screen never appears either. Own zoom/undo/redo live in `Toolbar.tsx`,
// driven by `CanvasHandle`.
import {
  CaptureUpdateAction,
  Excalidraw,
  FONT_FAMILY,
  MainMenu,
} from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import './canvas.css';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type {
  AppState,
  ExcalidrawImperativeAPI,
} from '@excalidraw/excalidraw/types';
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
  Rect,
  SceneElement,
  Viewport,
} from '../types.ts';
import {
  applyPatch,
  applyToApi,
  fitViewport,
  reconcileRemote,
  toSceneElements,
  zoomBy as zoomByFactor,
} from './convert.ts';

function rectOf(el: ExcalidrawElement): Rect {
  return { x: el.x, y: el.y, width: el.width, height: el.height };
}

function viewportOf(appState: AppState): Viewport {
  return {
    scrollX: appState.scrollX,
    scrollY: appState.scrollY,
    zoom: appState.zoom.value,
  };
}

function applyViewport(api: ExcalidrawImperativeAPI, next: Viewport): void {
  api.updateScene({
    appState: {
      scrollX: next.scrollX,
      scrollY: next.scrollY,
      zoom: { value: next.zoom as never },
    },
    captureUpdate: CaptureUpdateAction.NEVER,
  });
}

export const ExcalidrawCanvas = forwardRef<CanvasHandle, CanvasProps>(
  function ExcalidrawCanvas({ files, tool, onChange }, ref) {
    const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
    const containerRef = useRef<HTMLDivElement | null>(null);
    const addedFileIds = useRef<Set<string>>(new Set());

    // A stable ref callback: an inline arrow gets a new identity every render,
    // and Excalidraw treats that as a new API consumer each time — observed as
    // an infinite forceStoreRerender loop inside its own store (Maximum update
    // depth exceeded).
    const setApi = useCallback((instance: ExcalidrawImperativeAPI) => {
      apiRef.current = instance;
    }, []);

    // select/pan map onto Excalidraw's own tools; region/edge become
    // {type: 'custom'} (research/excalidraw: a custom tool gets no built-in
    // pointer behaviour, so DrawLayer.tsx never fights Excalidraw's own
    // drag-select/hand-pan). Ref callbacks (setApi) run in the commit phase,
    // before this effect, so `apiRef.current` is already set on first mount.
    useEffect(() => {
      const api = apiRef.current;
      if (!api) return;
      if (tool === 'select') api.setActiveTool({ type: 'selection' });
      else if (tool === 'pan') api.setActiveTool({ type: 'hand' });
      else api.setActiveTool({ type: 'custom', customType: tool });
    }, [tool]);

    // Every file this scene's images need, added once each — Excalidraw's own
    // file store has no delete, so `addedFileIds` only ever grows.
    useEffect(() => {
      const api = apiRef.current;
      if (!api) return;
      const fresh = [...files.entries()].filter(
        ([id]) => !addedFileIds.current.has(id),
      );
      if (!fresh.length) return;
      api.addFiles(
        fresh.map(
          ([id, f]) =>
            ({
              id,
              dataURL: f.dataURL,
              mimeType: f.mimeType,
              created: Date.now(),
              // biome-ignore lint/suspicious/noExplicitAny: BinaryFileData's branded DataURL/mimeType types aren't worth hand-narrowing here
            }) as any,
        ),
      );
      for (const [id] of fresh) addedFileIds.current.add(id);
    }, [files]);

    // Excalidraw commits updateScene asynchronously, so two applies in one
    // tick both read the pre-first-apply scene and the second silently
    // drops the first's elements (two connect() calls back to back lost an
    // edge, 2026-09-22). Until Excalidraw's onChange reports the applied
    // elements, the last applied list is the current one.
    const lastApplied = useRef<ExcalidrawElement[] | null>(null);
    const currentElements = useCallback(
      (api: ExcalidrawImperativeAPI) =>
        lastApplied.current ?? api.getSceneElementsIncludingDeleted(),
      [],
    );

    const onChangeInternal = useCallback(
      (elements: readonly ExcalidrawElement[], appState: AppState) => {
        // onChange also fires for unrelated state while an updateScene is
        // still pending; only a report that carries every applied element
        // at its applied version means the scene has caught up.
        const pending = lastApplied.current;
        if (pending) {
          const seen = new Map(elements.map((e) => [e.id, e.version]));
          if (pending.every((p) => (seen.get(p.id) ?? -1) >= p.version))
            lastApplied.current = null;
        }
        const ids = appState.selectedElementIds;
        onChange({
          elements: toSceneElements(elements),
          viewport: viewportOf(appState),
          selectedIds: Object.keys(ids).filter((id) => ids[id]),
        });
      },
      [onChange],
    );

    // A programmatic viewport change is a committed change too: Excalidraw does
    // not reliably fire onChange for an appState-only updateScene, and the
    // overlay above this canvas redraws only on onChange, so the seam emits it
    // itself. Measured 2026-09-22: a foreign shape's DOM rect stayed stale for
    // over 300 ms after zoomToFit, and a drag aimed at it hit empty canvas.
    const applyViewportAndEmit = useCallback(
      (api: ExcalidrawImperativeAPI, v: Viewport) => {
        applyViewport(api, v);
        const ids = api.getAppState().selectedElementIds;
        onChange({
          elements: toSceneElements(currentElements(api)),
          viewport: v,
          selectedIds: Object.keys(ids).filter((id) => ids[id]),
        });
      },
      [onChange, currentElements],
    );

    useImperativeHandle(
      ref,
      (): CanvasHandle => ({
        elements(): SceneElement[] {
          const api = apiRef.current;
          if (!api) return [];
          return toSceneElements(api.getSceneElementsIncludingDeleted());
        },
        apply(patch, opts) {
          const api = apiRef.current;
          if (!api) return;
          const next = applyPatch(patch, currentElements(api));
          lastApplied.current = next;
          applyToApi(api, next, opts?.history !== false);
          // The contract: onChange after every committed change. Excalidraw
          // batches back-to-back updateScene calls into one report, or
          // reports before the second commits; measured 2026-09-22, two
          // connects in a row reached the server as one edge in 4 of 5
          // runs. Report what was applied, now.
          const ids = api.getAppState().selectedElementIds;
          onChange({
            elements: toSceneElements(next),
            viewport: viewportOf(api.getAppState()),
            selectedIds: Object.keys(ids).filter((id) => ids[id]),
          });
        },
        applyRemote(raw) {
          const api = apiRef.current;
          if (!api) return;
          const next = reconcileRemote(
            raw,
            currentElements(api),
            api.getAppState(),
          );
          lastApplied.current = next;
          applyToApi(api, next, false);
        },
        select(ids) {
          const api = apiRef.current;
          if (!api) return;
          const live = new Set(
            api
              .getSceneElementsIncludingDeleted()
              .filter((e) => !e.isDeleted)
              .map((e) => e.id),
          );
          const selectedElementIds = Object.fromEntries(
            ids.filter((id) => live.has(id)).map((id) => [id, true] as const),
          );
          api.updateScene({
            appState: { selectedElementIds },
            captureUpdate: CaptureUpdateAction.NEVER,
          });
        },
        selectedIds() {
          const api = apiRef.current;
          if (!api) return [];
          const ids = api.getAppState().selectedElementIds;
          return Object.keys(ids).filter((id) => ids[id]);
        },
        viewport() {
          const api = apiRef.current;
          return api
            ? viewportOf(api.getAppState())
            : { scrollX: 0, scrollY: 0, zoom: 1 };
        },
        setViewport(v) {
          const api = apiRef.current;
          if (!api) return;
          const current = viewportOf(api.getAppState());
          applyViewportAndEmit(api, {
            scrollX: v.scrollX ?? current.scrollX,
            scrollY: v.scrollY ?? current.scrollY,
            zoom: v.zoom ?? current.zoom,
          });
        },
        zoomToFit(ids) {
          const api = apiRef.current;
          const box = containerRef.current?.getBoundingClientRect();
          if (!api || !box) return;
          const wanted = ids && new Set(ids);
          const rects = api
            .getSceneElementsIncludingDeleted()
            .filter((e) => !e.isDeleted && (!wanted || wanted.has(e.id)))
            .map(rectOf);
          const current = viewportOf(api.getAppState());
          applyViewportAndEmit(
            api,
            fitViewport(rects, box.width, box.height, current),
          );
        },
        zoomBy(factor) {
          const api = apiRef.current;
          const box = containerRef.current?.getBoundingClientRect();
          if (!api || !box) return;
          const current = viewportOf(api.getAppState());
          applyViewportAndEmit(
            api,
            zoomByFactor(current, factor, box.width / 2, box.height / 2),
          );
        },
        undo() {
          dispatchShortcut(containerRef.current, false);
        },
        redo() {
          dispatchShortcut(containerRef.current, true);
        },
      }),
    );

    return (
      <div
        ref={containerRef}
        className="digsite-canvas"
        style={{ position: 'absolute', inset: 0 }}
      >
        <Excalidraw
          excalidrawAPI={setApi}
          onChange={onChangeInternal}
          theme="light"
          UIOptions={{
            canvasActions: {
              changeViewBackgroundColor: false,
              clearCanvas: false,
              export: false,
              loadScene: false,
              saveToActiveFile: false,
              toggleTheme: false,
              saveAsImage: false,
            },
            tools: { image: false },
          }}
          initialData={{
            appState: {
              currentItemFontFamily: FONT_FAMILY.Helvetica,
              currentItemRoughness: 0,
              currentItemStrokeStyle: 'solid',
              currentItemFillStyle: 'solid',
              viewBackgroundColor: '#ffffff',
            },
          }}
        >
          <MainMenu />
        </Excalidraw>
      </div>
    );
  },
);

// No public undo()/redo() on ExcalidrawImperativeAPI in 0.18.1 (only
// `history.clear`) — the footer's own Undo/Redo buttons reach it through an
// internal actionManager we have no handle to. A real Ctrl+Z/Ctrl+Shift+Z
// keydown is the one input path guaranteed to trigger it: Excalidraw's own
// key handling is a React `onKeyDown` on its root container div
// (`.excalidraw`), so a synthetic, bubbling KeyboardEvent dispatched on that
// node reaches it exactly as a real keypress would (React 17+'s delegated
// listener sees any bubbling native event, not just ones from real input).
function dispatchShortcut(container: HTMLElement | null, redo: boolean): void {
  const target = container?.querySelector('.excalidraw');
  if (!target) return;
  const mac = navigator.platform.toLowerCase().includes('mac');
  target.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'z',
      code: 'KeyZ',
      ctrlKey: !mac,
      metaKey: mac,
      shiftKey: redo,
      bubbles: true,
      cancelable: true,
    }),
  );
}
