// Arrow keys walk from picture to picture (image-graph's
// `spatial.ts#neighbourInDirection`): the nearest picture whose centre lies
// within 60 degrees of the arrow's direction, where straight ahead beats a
// diagonal at the same distance. Pure: rects in, an id out.

export type Direction = 'left' | 'right' | 'up' | 'down';

interface Box {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

const AXIS: Record<Direction, [number, number]> = {
  left: [-1, 0],
  right: [1, 0],
  up: [0, -1],
  down: [0, 1],
};

/** Half-width of the cone a picture must sit in, as a cosine (60°). */
const CONE = Math.cos((60 * Math.PI) / 180);
/** How much sideways distance costs against distance ahead. */
const SIDEWAYS = 2;

export function nextInDirection(
  boxes: readonly Box[],
  fromId: string,
  direction: Direction,
): string | null {
  const from = boxes.find((b) => b.id === fromId);
  if (!from) return null;
  const [ax, ay] = AXIS[direction];
  const cx = from.x + from.width / 2;
  const cy = from.y + from.height / 2;
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const b of boxes) {
    if (b.id === fromId) continue;
    const dx = b.x + b.width / 2 - cx;
    const dy = b.y + b.height / 2 - cy;
    const dist = Math.hypot(dx, dy);
    if (!dist) continue;
    const ahead = dx * ax + dy * ay;
    if (ahead / dist < CONE) continue;
    const sideways = Math.abs(dx * ay - dy * ax);
    const score = ahead + SIDEWAYS * sideways;
    if (score < bestScore) {
      bestScore = score;
      best = b.id;
    }
  }
  return best;
}
