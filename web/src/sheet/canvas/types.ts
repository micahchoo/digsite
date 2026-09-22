// The seam's interface: everything a caller needs to know to use the canvas
// without importing `@excalidraw/*` (../../../.claude/rules/sheet-canvas-seam.md).
// `SceneElement` extends `@digsite/shared`'s own projection-side type of the
// same name (shared/src/sheet/project.ts — what the server-side projection
// and the stub already treat as "an element, decoupled from Excalidraw's
// branded type") with the extra fields the product reads or writes:
// grouping, bindings, arrow geometry/arrowheads and a bound text's display
// string. No file outside `canvas/` may import `@excalidraw/excalidraw` or
// name one of its types (`ExcalidrawElement`, `ExcalidrawImperativeAPI`) —
// enforced by `bun run lint:seams`.

import type {
  Direction,
  SceneElement as ProjectableElement,
  Properties,
} from '@digsite/shared';

export type Tool = 'select' | 'region' | 'edge' | 'pan';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Viewport {
  scrollX: number;
  scrollY: number;
  zoom: number;
}

export interface Binding {
  elementId: string;
  [key: string]: unknown;
}

export interface BoundElementRef {
  id: string;
  type: string;
}

export type Arrowhead = 'arrow' | 'triangle_outline' | null;

/** The product's own element shape — a superset of every field `dataOf`,
 * `dangling.ts`, `clamp.ts`, `hit.ts`, `screen.ts` and the e2e/smoke scripts
 * read off `window.__digsite.getElements()`. Structurally identical to an
 * Excalidraw element on these fields, but OUR type: nothing outside
 * `canvas/` imports the `@excalidraw` package to get it. */
export interface SceneElement extends ProjectableElement {
  /** Narrower than the inherited `boolean | undefined` — Excalidraw itself
   * never omits this field, and `sync.ts#SyncElement`/`dangling.ts`'s own
   * structural type both require it present. */
  isDeleted: boolean;
  updated: number;
  groupIds: readonly string[];
  boundElements: readonly BoundElementRef[] | null;
  startBinding: Binding | null;
  endBinding: Binding | null;
  points: readonly (readonly [number, number])[];
  startArrowhead: Arrowhead;
  endArrowhead: Arrowhead;
  /** Narrower than the inherited `unknown` (shared's `ProjectableElement`,
   * which only ever READS this through `dataOf`'s own validation) — a
   * one-level `el.customData?.kind`/`.imageId`/etc read, the shape every
   * e2e/smoke script and `dataOf` itself already expects, type-checks
   * without a cast. */
  customData?: Record<string, unknown>;
  /** Only present on a bound text element — the truncated DISPLAY string,
   * never the full label/relation (that lives in the container's
   * `customData`). */
  text?: string;
}

export interface SceneChange {
  elements: SceneElement[];
  viewport: Viewport;
  selectedIds: string[];
}

// -- ScenePatch: every way a caller may change the scene, in one call -----
// Two "build a new element" ops (the product hands over domain facts —
// image, rect, label/relation — and never an Excalidraw skeleton) and two
// "change what's there" ops, addressed by id. `id` on `addRegion`/`addEdge`
// is chosen by the CALLER (`crypto.randomUUID()` in tools.ts) rather than
// handed back by `apply`, so the interface stays a single `void` call.

export interface NewRegionOp {
  op: 'addRegion';
  id: string;
  imageId: string;
  groupId: string;
  rect: Rect;
  label: string;
  properties: Properties;
}

export interface NewEdgeOp {
  op: 'addEdge';
  id: string;
  fromId: string;
  toId: string;
  fromRect: Rect;
  toRect: Rect;
  relation: string;
  direction: Direction;
  properties: Properties;
}

export interface UpdateOp {
  op: 'update';
  id: string;
  changes: Partial<Omit<SceneElement, 'id'>>;
}

export interface RemoveOp {
  op: 'remove';
  ids: string[];
}

export type PatchOp = NewRegionOp | NewEdgeOp | UpdateOp | RemoveOp;
export type ScenePatch = PatchOp[];

export interface CanvasHandle {
  /** Live, including deleted elements inside the tombstone window
   * (`sync.ts#isSyncable`) — the same read `getSceneElementsIncludingDeleted`
   * gave callers before the split. */
  elements(): SceneElement[];
  /** Applies every op in order as ONE scene update (one re-render, one
   * history entry when `history` isn't false). `history: false` never
   * enters undo — the caller does not know `CaptureUpdateAction` exists. */
  apply(patch: ScenePatch, opts?: { history?: boolean }): void;
  /** Reconciles a raw snapshot from the wire (the 'joined' payload or a
   * 'scene' delta — both go through this one path, restored then
   * reconciled) against the live scene. Never enters undo. */
  applyRemote(elements: unknown[]): void;
  /** Replaces the whole selection; a foreign id (not a real element) clears
   * Excalidraw's own selection instead. Never enters undo. */
  select(ids: string[]): void;
  selectedIds(): string[];
  viewport(): Viewport;
  setViewport(v: Partial<Viewport>): void;
  zoomToFit(ids?: string[]): void;
  /** Zoom by `factor` (>1 in, <1 out) around the container's own centre —
   * the toolbar's zoom in/out buttons. Not in the brief's original sketch
   * (only `zoomToFit` was); added because the container's own pixel size,
   * which the anchor needs, is private to `canvas/` and has no business
   * leaking out to `Toolbar.tsx`. */
  zoomBy(factor: number): void;
  undo(): void;
  redo(): void;
}

export interface CanvasFile {
  id: string;
  dataURL: string;
  mimeType: string;
}

export interface CanvasProps {
  /** fileId -> loaded file, keyed by `@digsite/shared#fileId(imageId)`. A
   * new entry is added to the scene's file store on the next render; an
   * entry is never removed once added (Excalidraw's own file store has no
   * delete). Loaded by the caller (room.ts's `loadImages`) — the canvas
   * never fetches an original itself. */
  files: Map<string, CanvasFile>;
  tool: Tool;
  onChange(scene: SceneChange): void;
}
