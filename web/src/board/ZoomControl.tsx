// docs/ux/design.md §4.5 "Zoom bar": bottom-right, floats over the canvas,
// never resizes it — image-graph's `.image-graph-zoom` shape verbatim.
// docs/ux/audit.md #5 (blocker): the board had no on-screen zoom control at
// all, wheel-only. `%` is itself a button: click resets to 100% (zoom 0,
// `cellPx = 128 * 2^z` at z=0 is the board's native pixel size).
import { Icon } from '../components/Icon.tsx';
interface Props {
  zoom: number;
  minZoom: number;
  maxZoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
  onFit: () => void;
}

const ZOOM_STEP = 0.5;

export function zoomIn(zoom: number, maxZoom: number): number {
  return Math.min(maxZoom, zoom + ZOOM_STEP);
}
export function zoomOut(zoom: number, minZoom: number): number {
  return Math.max(minZoom, zoom - ZOOM_STEP);
}

export function ZoomControl({
  zoom,
  minZoom,
  maxZoom,
  onZoomIn,
  onZoomOut,
  onReset,
  onFit,
}: Props) {
  const pct = Math.round(2 ** zoom * 100);
  return (
    <div className="board-zoom" data-testid="board-zoom">
      <button
        type="button"
        data-testid="board-zoom-out"
        aria-label="Zoom out"
        disabled={zoom <= minZoom}
        onClick={onZoomOut}
      >
        <Icon name="minus" size={16} />
      </button>
      <button
        type="button"
        className="board-zoom-pct"
        data-testid="board-zoom-pct"
        aria-label="Reset zoom to 100%"
        title="Reset to 100%"
        onClick={onReset}
      >
        {pct}%
      </button>
      <button
        type="button"
        data-testid="board-zoom-in"
        aria-label="Zoom in"
        disabled={zoom >= maxZoom}
        onClick={onZoomIn}
      >
        <Icon name="plus" size={16} />
      </button>
      <button
        type="button"
        data-testid="board-zoom-fit"
        aria-label="Fit everything"
        title="Fit everything"
        onClick={onFit}
      >
        <Icon name="fit" size={16} />
      </button>
    </div>
  );
}
