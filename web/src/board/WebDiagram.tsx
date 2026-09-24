// The web of claims as a picture you can move around: pictures on hop rings
// (web-layout.ts), each claim a line bent to its own side, confidence as the
// line's dash. It draws what it is handed and asks nothing of the server,
// so the board's web view (WebView.tsx) and a report's reader
// (web/src/report/) show the web the same way.
import type { Confidence } from '@digsite/shared';
import {
  forwardRef,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useEffect } from 'react';
import { useWheel } from '../lib/use-wheel.ts';
import { type LayoutEdge, NODE, type Placed } from './web-layout.ts';

export type WebEdge = LayoutEdge & {
  id: string;
  relation: string;
  confidence: Confidence | null;
};

export interface WebDiagramHandle {
  /** Frames every picture. */
  fit(): void;
}

interface Props {
  edges: readonly WebEdge[];
  placed: readonly Placed[];
  /** Ringed: the pictures the web starts from. */
  roots: readonly string[];
  /** A picture's pixels and name. */
  srcOf: (imageId: string) => string;
  nameOf: (imageId: string) => string;
  selected: string | null;
  onSelect: (imageId: string | null) => void;
  /** Double-click or Enter on a picture. Absent: nothing to walk to. */
  onWalk?: (imageId: string) => void;
  /** Only this relation's lines at full strength; null for all. */
  emphasis: string | null;
  /** Names the drawing for a screen reader when no dialog does. */
  label?: string;
  testId?: string;
  /** In a document: a plain wheel scrolls the page, a pinch or Ctrl+wheel
   * zooms (the report's web figure). Otherwise every wheel zooms. */
  inPage?: boolean;
}

const THUMB = 72;
const DASH: Record<string, string | undefined> = {
  likely: '9 5',
  unverified: '2 4',
};

type View = { x: number; y: number; scale: number };

/** A line bent a little to one side: two claims on one axis, or a claim
 * passing a picture on its way, stay apart instead of drawn over each
 * other. Returns the path and the point half way along it. */
function bent(
  a: { x: number; y: number },
  b: { x: number; y: number },
  /** Which of the claims on this pair: each bends to its own side. */
  nth = 0,
): { d: string; mid: { x: number; y: number } } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  // A long line passes more pictures on its way, so it bends further.
  const reach = Math.hypot(dx, dy) > 400 ? 0.22 : 0.14;
  const side = nth % 2 === 0 ? 1 : -1;
  const bend = reach * side * (1 + Math.floor(nth / 2) * 0.8);
  const c = { x: (a.x + b.x) / 2 - dy * bend, y: (a.y + b.y) / 2 + dx * bend };
  return {
    d: `M ${a.x} ${a.y} Q ${c.x} ${c.y} ${b.x} ${b.y}`,
    mid: { x: (a.x + 2 * c.x + b.x) / 4, y: (a.y + 2 * c.y + b.y) / 4 },
  };
}

export const WebDiagram = forwardRef<WebDiagramHandle, Props>(
  function WebDiagram(
    {
      edges,
      placed,
      roots,
      srcOf,
      nameOf,
      selected,
      onSelect,
      onWalk,
      emphasis,
      label,
      testId = 'web-view-canvas',
      inPage = false,
    },
    ref,
  ) {
    const svgRef = useRef<SVGSVGElement | null>(null);
    const [view, setView] = useState<View>({ x: 0, y: 0, scale: 1 });
    const drag = useRef<{ x: number; y: number } | null>(null);
    const at = useMemo(() => new Map(placed.map((p) => [p.id, p])), [placed]);

    function fit() {
      const svg = svgRef.current;
      if (!svg || !placed.length) return;
      const box = svg.getBoundingClientRect();
      const xs = placed.map((p) => p.x);
      const ys = placed.map((p) => p.y);
      const w = Math.max(...xs) - Math.min(...xs) + NODE * 2;
      const h = Math.max(...ys) - Math.min(...ys) + NODE * 2;
      const scale = Math.min(1.4, box.width / w, box.height / h);
      setView({
        scale,
        x: box.width / 2 - ((Math.max(...xs) + Math.min(...xs)) / 2) * scale,
        y: box.height / 2 - ((Math.max(...ys) + Math.min(...ys)) / 2) * scale,
      });
    }
    useImperativeHandle(ref, () => ({ fit }));
    // Fit the whole web when a new one arrives.
    // biome-ignore lint/correctness/useExhaustiveDependencies: a new layout is the trigger
    useEffect(() => fit(), [placed]);

    // Which claim on its pair each edge is, so two claims on one pair of
    // pictures bend apart and stay readable.
    const pairIndex = useMemo(() => {
      const seen = new Map<string, number>();
      const out = new Map<string, number>();
      for (const e of [...edges].sort((p, q) => p.id.localeCompare(q.id))) {
        const [x, y] = [e.source.imageId, e.target.imageId].sort();
        const key = `${x}|${y}`;
        const n = seen.get(key) ?? 0;
        seen.set(key, n + 1);
        out.set(e.id, n);
      }
      return out;
    }, [edges]);

    useWheel(svgRef, (e, svg) => {
      if (inPage && !e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const box = svg.getBoundingClientRect();
      const px = e.clientX - box.left;
      const py = e.clientY - box.top;
      const factor = Math.exp(-e.deltaY * 0.0015);
      setView((v) => {
        const scale = Math.min(4, Math.max(0.1, v.scale * factor));
        const k = scale / v.scale;
        return { scale, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
      });
    });

    const touching = (e: WebEdge, id: string | null) =>
      id !== null && (e.source.imageId === id || e.target.imageId === id);
    const showLabels = edges.length <= 40;

    return (
      <svg
        ref={svgRef}
        className="web-view-canvas"
        data-testid={testId}
        role={label ? 'img' : undefined}
        aria-label={label}
        onPointerDown={(e) => {
          if (e.button !== 0 || e.target !== e.currentTarget) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY };
          onSelect(null);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          drag.current = { x: e.clientX, y: e.clientY };
          setView((v) => ({
            ...v,
            x: v.x + e.clientX - d.x,
            y: v.y + e.clientY - d.y,
          }));
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
      >
        <defs>
          <clipPath id="web-thumb">
            <rect
              x={-THUMB / 2}
              y={-THUMB / 2}
              width={THUMB}
              height={THUMB}
              rx={8}
            />
          </clipPath>
        </defs>
        <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
          {edges.map((edge) => {
            const a = at.get(edge.source.imageId);
            const b = at.get(edge.target.imageId);
            if (!a || !b) return null;
            const lit =
              (emphasis === null || edge.relation === emphasis) &&
              (selected === null || touching(edge, selected));
            const { d, mid } = bent(a, b, pairIndex.get(edge.id));
            const text = edge.relation || 'unnamed';
            // A solid chip: a halo around the glyphs alone lets the line
            // show through the space between words.
            const width = text.length * 6.6 + 12;
            return (
              <g
                key={edge.id}
                className="web-view-edge"
                data-testid="web-view-edge"
                opacity={lit ? 1 : 0.18}
              >
                <path
                  d={d}
                  strokeDasharray={
                    edge.confidence ? DASH[edge.confidence] : undefined
                  }
                />
                {(showLabels || touching(edge, selected)) && lit && (
                  <>
                    <rect
                      x={mid.x - width / 2}
                      y={mid.y - 9}
                      width={width}
                      height={18}
                      rx={9}
                    />
                    <text x={mid.x} y={mid.y}>
                      {text}
                    </text>
                  </>
                )}
              </g>
            );
          })}
          {placed.map((p) => {
            const isRoot = roots.includes(p.id);
            return (
              <g
                key={p.id}
                // biome-ignore lint/a11y/useSemanticElements: an SVG group cannot be a <button>; it takes the role and the keys
                role="button"
                tabIndex={0}
                aria-label={`${nameOf(p.id)}, ${p.hops} step${p.hops === 1 ? '' : 's'} out`}
                className={`web-view-node${isRoot ? ' is-root' : ''}${selected === p.id ? ' is-selected' : ''}`}
                data-testid="web-view-node"
                data-image-id={p.id}
                transform={`translate(${p.x} ${p.y})`}
                onClick={() => onSelect(p.id)}
                onDoubleClick={() => onWalk?.(p.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onWalk?.(p.id);
                  if (e.key === ' ') {
                    e.preventDefault();
                    onSelect(p.id);
                  }
                }}
              >
                <rect
                  x={-THUMB / 2 - 3}
                  y={-THUMB / 2 - 3}
                  width={THUMB + 6}
                  height={THUMB + 6}
                  rx={10}
                />
                <image
                  href={srcOf(p.id)}
                  x={-THUMB / 2}
                  y={-THUMB / 2}
                  width={THUMB}
                  height={THUMB}
                  preserveAspectRatio="xMidYMid slice"
                  clipPath="url(#web-thumb)"
                />
                {view.scale > 0.55 && (
                  <text y={THUMB / 2 + 16}>{nameOf(p.id)}</text>
                )}
              </g>
            );
          })}
        </g>
      </svg>
    );
  },
);
