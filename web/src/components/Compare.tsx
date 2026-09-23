// Two pictures, one view: the act of checking a claim that two things are
// the same place, the same object, or one made from the other. Side by
// side, a swipe across one stack, or one laid over the other, where the
// difference blend lights up exactly what an edit changed.
//
// One zoom and one pan drive both sides (compare-view.ts). A region end is
// framed on its region, so two regions line up corner to corner.
import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon.tsx';
import {
  type Focus,
  type Pane,
  START,
  type Side,
  type View,
  panBy,
  placement,
  zoomAt,
} from './compare-view.ts';

export interface CompareEnd {
  /** The full-resolution picture: detail is the point. */
  src: string;
  name: string;
  /** A region's label, when this end is a region. */
  label?: string | null;
  focus: Focus;
}

type Mode = 'side' | 'swipe' | 'overlay';

const MODES: { mode: Mode; label: string; key: string }[] = [
  { mode: 'side', label: 'Side by side', key: '1' },
  { mode: 'swipe', label: 'Swipe', key: '2' },
  { mode: 'overlay', label: 'Overlay', key: '3' },
];

interface Props {
  a: CompareEnd;
  b: CompareEnd;
  /** What the comparison is checking, e.g. the connection's relation. */
  title?: string;
  onClose: () => void;
}

/** The pane's size, kept current. A callback ref, because a pane unmounts
 * and remounts as the mode changes and the observer must follow it. */
function usePaneSize(): [(el: HTMLDivElement | null) => void, Pane] {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState<Pane>({ width: 1, height: 1 });
  useEffect(() => {
    if (!el) return;
    const measure = () =>
      setSize({ width: el.clientWidth || 1, height: el.clientHeight || 1 });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return [setEl, size];
}

export function Compare({ a, b, title, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [mode, setMode] = useState<Mode>('side');
  const [view, setView] = useState<View>(START);
  const [divider, setDivider] = useState(0.5);
  const [opacity, setOpacity] = useState(0.5);
  const [difference, setDifference] = useState(false);
  const [natural, setNatural] = useState<{
    a: [number, number] | null;
    b: [number, number] | null;
  }>({ a: null, b: null });
  const [paneA, sizeA] = usePaneSize();
  const [paneB, sizeB] = usePaneSize();
  const drag = useRef<{ x: number; y: number; side: Side; pane: Pane } | null>(
    null,
  );

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const sideA: Side | null = natural.a
    ? { width: natural.a[0], height: natural.a[1], focus: a.focus }
    : null;
  const sideB: Side | null = natural.b
    ? { width: natural.b[0], height: natural.b[1], focus: b.focus }
    : null;
  // Stacked modes draw both in pane A's frame.
  const stacked = mode !== 'side';

  function onWheel(e: React.WheelEvent, side: Side | null, pane: Pane) {
    if (!side) return;
    const box = e.currentTarget.getBoundingClientRect();
    const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
    setView((v) =>
      zoomAt(
        v,
        factor,
        { x: e.clientX - box.left, y: e.clientY - box.top },
        side,
        pane,
      ),
    );
  }
  function onPointerDown(e: React.PointerEvent, side: Side | null, pane: Pane) {
    if (!side || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, side, pane };
  }
  function onPointerMove(e: React.PointerEvent) {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    drag.current = { ...d, x: e.clientX, y: e.clientY };
    setView((v) => panBy(v, dx, dy, d.side, d.pane));
  }
  const endDrag = () => {
    drag.current = null;
  };

  function onKeyDown(e: React.KeyboardEvent) {
    // A slider takes its own arrows; a radio or a checkbox leaves keys here.
    const target = e.target as HTMLInputElement;
    if (
      target.tagName === 'INPUT' &&
      !['radio', 'checkbox'].includes(target.type)
    )
      return;
    const side = sideA;
    const found = MODES.find((m) => m.key === e.key);
    if (found) return setMode(found.mode);
    if (!side) return;
    const centre = { x: sizeA.width / 2, y: sizeA.height / 2 };
    if (e.key === '+' || e.key === '=')
      setView((v) => zoomAt(v, 1.25, centre, side, sizeA));
    else if (e.key === '-') setView((v) => zoomAt(v, 0.8, centre, side, sizeA));
    else if (e.key === '0') setView(START);
    else if (e.key.startsWith('Arrow')) {
      const step = 40;
      const [dx, dy] =
        e.key === 'ArrowLeft'
          ? [step, 0]
          : e.key === 'ArrowRight'
            ? [-step, 0]
            : e.key === 'ArrowUp'
              ? [0, step]
              : [0, -step];
      e.preventDefault();
      setView((v) => panBy(v, dx, dy, side, sizeA));
    }
  }

  const picture = (
    end: CompareEnd,
    side: Side | null,
    pane: Pane,
    which: 'a' | 'b',
    style: React.CSSProperties = {},
  ) => {
    const place = side ? placement(side, pane, view) : null;
    return (
      <img
        src={end.src}
        alt={end.label ? `${end.label}, on ${end.name}` : end.name}
        className="compare-picture"
        data-testid={`compare-picture-${which}`}
        draggable={false}
        onLoad={(e) => {
          const img = e.currentTarget;
          setNatural((n) => ({
            ...n,
            [which]: [img.naturalWidth, img.naturalHeight],
          }));
        }}
        style={{
          ...(place
            ? {
                left: place.left,
                top: place.top,
                width: place.width,
                height: place.height,
              }
            : { visibility: 'hidden' }),
          ...style,
        }}
      />
    );
  };

  const caption = (end: CompareEnd) => (
    <figcaption>
      {end.label ? <b>{end.label}</b> : null}
      <span>{end.name}</span>
    </figcaption>
  );

  return (
    <dialog
      ref={dialogRef}
      className="compare"
      data-testid="compare"
      aria-label={title ? `Compare: ${title}` : 'Compare two pictures'}
      onClose={onClose}
      onKeyDown={onKeyDown}
    >
      <header className="compare-head">
        <h2>{title ?? 'Compare'}</h2>
        <div className="segmented" role="radiogroup" aria-label="Compare by">
          {MODES.map((m) => (
            <label key={m.mode} title={`${m.label} (${m.key})`}>
              <input
                type="radio"
                name="compare-mode"
                checked={mode === m.mode}
                data-testid={`compare-mode-${m.mode}`}
                onChange={() => setMode(m.mode)}
              />
              {m.label}
            </label>
          ))}
        </div>
        {mode === 'overlay' && (
          <div className="compare-overlay-controls">
            <label>
              Top picture
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={opacity}
                aria-label="Opacity of the top picture"
                data-testid="compare-opacity"
                onChange={(e) => setOpacity(Number(e.target.value))}
              />
            </label>
            <label>
              <input
                type="checkbox"
                checked={difference}
                data-testid="compare-difference"
                onChange={(e) => setDifference(e.target.checked)}
              />
              Difference
            </label>
          </div>
        )}
        <output className="compare-zoom" data-testid="compare-zoom">
          {Math.round(view.zoom * 100)}%
        </output>
        <button type="button" onClick={() => setView(START)} title="Reset (0)">
          Reset
        </button>
        <button
          type="button"
          className="compare-close"
          aria-label="Close comparison"
          onClick={() => dialogRef.current?.close()}
        >
          <Icon name="close" size={16} />
        </button>
      </header>
      <div className={`compare-body compare-body--${mode}`}>
        <figure className="compare-figure">
          <div
            ref={paneA}
            className="compare-pane"
            data-testid="compare-pane-a"
            onWheel={(e) => onWheel(e, sideA, sizeA)}
            onPointerDown={(e) => onPointerDown(e, sideA, sizeA)}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            {picture(a, sideA, sizeA, 'a')}
            {stacked &&
              picture(
                b,
                sideB,
                sizeA,
                'b',
                mode === 'swipe'
                  ? { clipPath: `inset(0 0 0 ${divider * 100}%)` }
                  : {
                      opacity: difference ? 1 : opacity,
                      mixBlendMode: difference ? 'difference' : 'normal',
                    },
              )}
            {mode === 'swipe' && (
              <div
                role="slider"
                tabIndex={0}
                className="compare-divider"
                aria-label="Swipe between the two pictures"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(divider * 100)}
                data-testid="compare-divider"
                style={{ left: `${divider * 100}%` }}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  e.currentTarget.setPointerCapture(e.pointerId);
                }}
                onPointerMove={(e) => {
                  if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
                  const box =
                    e.currentTarget.parentElement?.getBoundingClientRect();
                  if (!box) return;
                  setDivider(
                    Math.min(
                      1,
                      Math.max(0, (e.clientX - box.left) / box.width),
                    ),
                  );
                }}
                onKeyDown={(e) => {
                  const step =
                    e.key === 'ArrowLeft'
                      ? -0.02
                      : e.key === 'ArrowRight'
                        ? 0.02
                        : 0;
                  if (!step) return;
                  e.preventDefault();
                  e.stopPropagation();
                  setDivider((d) => Math.min(1, Math.max(0, d + step)));
                }}
              />
            )}
          </div>
          {stacked ? (
            <figcaption className="compare-stack-caption">
              <span>
                {a.label ? `${a.label} · ` : ''}
                {a.name}
              </span>
              <span>
                {b.label ? `${b.label} · ` : ''}
                {b.name}
              </span>
            </figcaption>
          ) : (
            caption(a)
          )}
        </figure>
        {!stacked && (
          <figure className="compare-figure">
            <div
              ref={paneB}
              className="compare-pane"
              data-testid="compare-pane-b"
              onWheel={(e) => onWheel(e, sideB, sizeB)}
              onPointerDown={(e) => onPointerDown(e, sideB, sizeB)}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
            >
              {picture(b, sideB, sizeB, 'b')}
            </div>
            {caption(b)}
          </figure>
        )}
      </div>
      <p className="compare-help">
        Scroll to zoom both, drag to move both. 1 2 3 change the view, 0 resets,
        Esc closes.
      </p>
    </dialog>
  );
}
