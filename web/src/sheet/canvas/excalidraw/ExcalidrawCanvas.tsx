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
  useState,
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

    // docs/ux/audit.md #2 and #3. Three compounding problems, all in how the
    // installed 0.18.1's `App` class hands back its imperative API:
    //
    // 1. `excalidrawAPI(api)` fires from `App`'s own CONSTRUCTOR — render
    //    phase, before commit — not from a ref callback (which React only
    //    invokes at commit time). `apiRef.current` can therefore be set
    //    before this component, or Excalidraw itself, has actually mounted.
    // 2. Excalidraw's own mount can happen in a LATER commit than this
    //    component's (measured: this component's own `[]`-effect can run
    //    with `apiRef.current` still null — Excalidraw was not even
    //    constructed yet), so a ONE-SHOT "flush once mounted" effect is not
    //    enough; the flush has to re-arm every time the API changes.
    // 3. Under React StrictMode (`main.tsx`), every class component's
    //    constructor runs TWICE on mount and the first instance is fully
    //    discarded — but `excalidrawAPI` fires unconditionally from EACH
    //    construction, so `setApi` can be called with a "zombie" instance
    //    that never mounts. Calling any state-touching method on it throws
    //    React's "Can't call setState on a component that is not yet
    //    mounted" and silently no-ops — worse, draining a retry queue
    //    against it loses the call for good, same as problem 1.
    //
    // The fix: `setApi` only ever touches the ref (always safe) and bumps
    // `apiTick`, a piece of state — never acts on `instance` itself. The
    // effect below is keyed on `apiTick`, so it re-runs, post-commit, every
    // time `setApi` fires, however many times that is; it reads
    // `apiRef.current` fresh rather than trusting any particular `setApi`
    // call's `instance`. React 18 batches synchronous setState calls (the
    // zombie's and the real one's `setApi`, called back-to-back from
    // Excalidraw's own double-construction) into ONE render, so by the time
    // this effect runs, `apiRef.current` already holds whichever instance
    // is canonical — never the discarded one. `mountedRef` records that a
    // flush has found a real API at least once; readyApi() is null before
    // that, so a caller that arrives too early queues instead of running
    // against a not-yet-settled ref. Before this fix: a socket 'joined'
    // payload that raced ahead of readiness left the scene at 0 elements
    // forever, and a `files` update that raced ahead left every image an
    // unregistered `fileId` — Excalidraw's own `drawImagePlaceholder` —
    // forever (both one-shot effects that never re-ran on their own).
    const mountedRef = useRef(false);
    const readyQueue = useRef<Array<() => void>>([]);
    const [apiTick, setApiTick] = useState(0);

    /** The API, but only once a flush has found it genuinely set — see the
     * block comment above for why `apiRef.current` alone is not enough.
     * `useCallback` with no deps: it reads two refs and nothing else, so
     * its identity never needs to change, which lets the effects below
     * name it as a dependency honestly instead of suppressing the lint. */
    const readyApi = useCallback(
      (): ExcalidrawImperativeAPI | null =>
        mountedRef.current ? apiRef.current : null,
      [],
    );

    // A stable ref callback: an inline arrow gets a new identity every render,
    // and Excalidraw treats that as a new API consumer each time — observed as
    // an infinite forceStoreRerender loop inside its own store (Maximum update
    // depth exceeded). Only ever assigns the ref and bumps state — see
    // readyApi's comment for why nothing here acts on `instance` itself.
    const setApi = useCallback((instance: ExcalidrawImperativeAPI) => {
      apiRef.current = instance;
      setApiTick((t) => t + 1);
    }, []);

    // apiTick is a trigger, not a value read in the body — deliberately
    // re-runs on every `setApi` call so a later-arriving real instance is
    // never missed because an earlier run saw a null or zombie ref.
    // biome-ignore lint/correctness/useExhaustiveDependencies: apiTick drives re-runs on purpose; apiRef/readyQueue/mountedRef are refs, read fresh every run
    useEffect(() => {
      if (!apiRef.current) return;
      mountedRef.current = true;
      if (readyQueue.current.length) {
        const queued = readyQueue.current;
        readyQueue.current = [];
        // One macrotask out, deliberately: `<Excalidraw>`'s own mount-time
        // handling of `initialData` (fonts, scene setup) can still be in
        // flight in the SAME commit as this effect — a queued
        // `updateScene` run synchronously here was measured to be clobbered
        // moments later, scene back to 0 elements, no error, no queue item
        // left to retry. A `setTimeout` runs after this commit (and
        // Excalidraw's own post-mount work) fully settles; cleared on
        // unmount so a fast navigation away never applies a queued call to
        // a dead component.
        const timer = window.setTimeout(() => {
          for (const run of queued) run();
        }, 0);
        return () => {
          window.clearTimeout(timer);
          mountedRef.current = false;
        };
      }
      return () => {
        mountedRef.current = false;
      };
    }, [apiTick]);

    // select/pan map onto Excalidraw's own tools; region/edge become
    // {type: 'custom'} (research/excalidraw: a custom tool gets no built-in
    // pointer behaviour, so DrawLayer.tsx never fights Excalidraw's own
    // drag-select/hand-pan). A tool picked before the API is ready is
    // applied once it is (readyQueue above).
    useEffect(() => {
      const run = () => {
        const api = readyApi();
        if (!api) return;
        if (tool === 'select') api.setActiveTool({ type: 'selection' });
        else if (tool === 'pan') api.setActiveTool({ type: 'hand' });
        else api.setActiveTool({ type: 'custom', customType: tool });
      };
      if (!readyApi()) {
        readyQueue.current.push(run);
        return;
      }
      run();
    }, [tool, readyApi]);

    // Every file this scene's images need, added once each — Excalidraw's own
    // file store has no delete, so `addedFileIds` only ever grows. `files`
    // itself can be fully populated (both `loadImages` callers — Sheet.tsx's
    // own mount effect and room.ts's 'joined' handler — run independently of
    // this component's mount) before the API is ready; queueing the flush
    // (rather than dropping it) is what makes this effect eventually run
    // even though `files` never changes again afterwards.
    const flushFiles = useCallback(
      (api: ExcalidrawImperativeAPI) => {
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
      },
      [files],
    );

    useEffect(() => {
      const api = readyApi();
      if (!api) {
        readyQueue.current.push(() => {
          const ready = readyApi();
          if (ready) flushFiles(ready);
        });
        return;
      }
      flushFiles(api);
    }, [flushFiles, readyApi]);

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

    // Shared by the imperative `applyRemote` and its readyQueue replay below
    // — the same reconcile-then-commit whether it runs now or once `apiRef`
    // becomes ready.
    const runApplyRemote = useCallback(
      (api: ExcalidrawImperativeAPI, raw: unknown[]) => {
        const next = reconcileRemote(
          raw,
          currentElements(api),
          api.getAppState(),
        );
        lastApplied.current = next;
        applyToApi(api, next, false);
      },
      [currentElements],
    );

    useImperativeHandle(
      ref,
      (): CanvasHandle => ({
        elements(): SceneElement[] {
          const api = readyApi();
          if (!api) return [];
          return toSceneElements(api.getSceneElementsIncludingDeleted());
        },
        apply(patch, opts) {
          const api = readyApi();
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
          const api = readyApi();
          // docs/ux/audit.md #3: a 'joined'/'scene' payload that arrives
          // before Excalidraw's own API is ready used to be dropped here —
          // silently, with no retry — leaving the scene at 0 elements for
          // good. Queue it instead; the flush effect replays every queued
          // call, in order, the moment the API exists.
          if (!api) {
            readyQueue.current.push(() => {
              const ready = readyApi();
              if (ready) runApplyRemote(ready, raw);
            });
            return;
          }
          runApplyRemote(api, raw);
        },
        select(ids) {
          const api = readyApi();
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
          const api = readyApi();
          if (!api) return [];
          const ids = api.getAppState().selectedElementIds;
          return Object.keys(ids).filter((id) => ids[id]);
        },
        viewport() {
          const api = readyApi();
          return api
            ? viewportOf(api.getAppState())
            : { scrollX: 0, scrollY: 0, zoom: 1 };
        },
        setViewport(v) {
          const api = readyApi();
          if (!api) return;
          const current = viewportOf(api.getAppState());
          applyViewportAndEmit(api, {
            scrollX: v.scrollX ?? current.scrollX,
            scrollY: v.scrollY ?? current.scrollY,
            zoom: v.zoom ?? current.zoom,
          });
        },
        zoomToFit(ids) {
          const api = readyApi();
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
          const api = readyApi();
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
