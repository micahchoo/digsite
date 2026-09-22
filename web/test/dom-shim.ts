// A DOM shim minimal enough to let @excalidraw/excalidraw load and run its
// pure element-building functions (convertToExcalidrawElements,
// newElementWith, restoreElements, reconcileElements) outside a browser —
// bun test has no DOM by default. Real browser behaviour (rendering,
// layout) is not emulated; canvas 2D comes from @napi-rs/canvas (already a
// devDependency, used elsewhere for real pixel output), a Proxy stands in
// for anything else DOM-shaped.
import { createCanvas } from '@napi-rs/canvas';

function noop() {}
function stubTarget(): Record<string, unknown> {
  return { addEventListener: noop, removeEventListener: noop, style: {} };
}
const benign: unknown = new Proxy(stubTarget(), {
  get(target, prop) {
    if (prop in target)
      return (target as Record<string, unknown>)[prop as string];
    if (
      prop === Symbol.toPrimitive ||
      prop === 'toString' ||
      prop === 'valueOf'
    ) {
      return () => '';
    }
    return noop;
  },
  has() {
    return true;
  },
});

const g = globalThis as unknown as Record<string, unknown>;
g.window = globalThis;
g.navigator = { userAgent: 'bun-test', platform: 'test' };
g.location = { origin: 'http://localhost', href: 'http://localhost/' };
g.devicePixelRatio = 1;
g.matchMedia = () => ({
  matches: false,
  addEventListener: noop,
  removeEventListener: noop,
});
g.localStorage = { getItem: () => null, setItem: noop, removeItem: noop };
g.ResizeObserver = class {
  observe = noop;
  unobserve = noop;
  disconnect = noop;
};
g.document = {
  createElement: (tag: string) =>
    tag === 'canvas' ? createCanvas(1, 1) : benign,
  addEventListener: noop,
  removeEventListener: noop,
  documentElement: benign,
  body: benign,
  fonts: { ready: Promise.resolve(), addEventListener: noop },
};

class FakeElement {
  style: Record<string, unknown> = {};
  addEventListener() {}
  removeEventListener() {}
  getBoundingClientRect() {
    return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }
}
g.Element = FakeElement;
g.HTMLElement = FakeElement;
g.Node = FakeElement;
g.Event = class {};
g.CustomEvent = class {};
g.KeyboardEvent = class {};
g.PointerEvent = class {};
g.MouseEvent = class {};
g.getComputedStyle = () => ({ getPropertyValue: () => '' });
g.requestAnimationFrame = (cb: (t: number) => void) =>
  setTimeout(() => cb(Date.now()), 0);
g.cancelAnimationFrame = (id: number) => clearTimeout(id);
// Bound-text label registration (convertToExcalidrawElements) loads a
// FontFace per family; load() resolving immediately is enough for a
// pure build — no font is actually rasterised in a test.
class FakeFontFace {
  family: string;
  constructor(family: string) {
    this.family = family;
  }
  load() {
    return Promise.resolve(this);
  }
}
g.FontFace = FakeFontFace;
