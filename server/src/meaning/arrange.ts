// A board arranged by meaning (roadmap item 6): one position per embedded
// image, so that on the 16-wide map a picture's neighbours across AND down
// are near it in meaning. The map is rows of 16, so a group of 50 similar
// pictures should land as a block of about three rows, not as a line.
//
// A bisecting 2-means tree: split the set in two by meaning, split each
// half again, down to leaves of LEAF images, then read the leaves in order.
// Two choices make neighbours near, not only groups:
//  - At each split, the half that comes first is the one nearer to what
//    was placed just before it, so a boundary between two groups joins
//    the two closest ends.
//  - Inside a leaf, pictures follow a nearest-neighbour chain from that
//    same end.
// A split that would leave under MIN_SHARE on one side splits at the
// median instead, so the tree stays about log2(N) deep and the cost about
// N x D x log(N).
//
// Pure: vectors in, order out. Measured in docs/measurements/
// meaning-at-scale.md "A map arranged by meaning".

const LEAF = 16;
const MIN_SHARE = 0.1;
const ITERATIONS = 4;

/** Unit vectors, `dims` each, packed row after row. */
/** `data` is float32, or int8 scaled by 127 for a board too big for the
 * budget (embeddings.ts): every comparison here is between vectors on one
 * scale, so either gives the same kind of answer. */
export type Vectors = {
  data: Float32Array | Int8Array;
  count: number;
  dims: number;
};
type Row = Float32Array | Int8Array;

function dotRow(v: Vectors, i: number, w: Row): number {
  const { data, dims } = v;
  const o = i * dims;
  let sum = 0;
  for (let k = 0; k < dims; k++)
    sum += (data[o + k] as number) * (w[k] as number);
  return sum;
}

function dotRows(v: Vectors, i: number, j: number): number {
  const { data, dims } = v;
  const a = i * dims;
  const b = j * dims;
  let sum = 0;
  for (let k = 0; k < dims; k++) {
    sum += (data[a + k] as number) * (data[b + k] as number);
  }
  return sum;
}

/** Scratch the whole run reuses. A typed array's memory lives outside
 * the JS heap, so ~60,000 splits each allocating their own grew RSS from
 * 2.5 to 6 GB at a million images while the heap stayed flat. */
type Work = {
  ca: Float32Array;
  cb: Float32Array;
  w: Float32Array;
  score: Float32Array;
  sorted: Float32Array;
  held: Int32Array;
};

function workFor(v: Vectors): Work {
  return {
    ca: new Float32Array(v.dims),
    cb: new Float32Array(v.dims),
    w: new Float32Array(v.dims),
    score: new Float32Array(v.count),
    sorted: new Float32Array(v.count),
    held: new Int32Array(v.count),
  };
}

/** The mean of idx[from..to), written into `c`. */
function centroid(
  v: Vectors,
  idx: Int32Array,
  from: number,
  to: number,
  c: Float32Array,
): Float32Array {
  const { data, dims } = v;
  c.fill(0);
  for (let p = from; p < to; p++) {
    const o = (idx[p] as number) * dims;
    for (let k = 0; k < dims; k++)
      c[k] = (c[k] as number) + (data[o + k] as number);
  }
  const n = to - from;
  for (let k = 0; k < dims; k++) c[k] = (c[k] as number) / n;
  return c;
}

/** The member of idx[from..to) least similar to row `i`. */
function farthest(
  v: Vectors,
  idx: Int32Array,
  from: number,
  to: number,
  i: number,
): number {
  let best = idx[from] as number;
  let low = Number.POSITIVE_INFINITY;
  for (let p = from; p < to; p++) {
    const j = idx[p] as number;
    const s = dotRows(v, i, j);
    if (s < low) {
      low = s;
      best = j;
    }
  }
  return best;
}

/** Splits idx[from..to) in place into two halves by meaning; returns
 * where the second half starts. */
function split(
  v: Vectors,
  idx: Int32Array,
  from: number,
  to: number,
  work: Work,
): number {
  const { dims } = v;
  const n = to - from;
  // Seeds: the two ends of the set, found by two farthest-point passes.
  const a = farthest(v, idx, from, to, idx[from] as number);
  const b = farthest(v, idx, from, to, a);
  const { ca, cb, w } = work;
  const o = v.data;
  for (let k = 0; k < dims; k++) {
    ca[k] = o[a * dims + k] as number;
    cb[k] = o[b * dims + k] as number;
  }
  // Two centroids decide by the sign of x.(ca - cb) - (|ca|² - |cb|²)/2.
  // In place, no sort: at a million images a sort per iteration left the
  // heap gigabytes behind its garbage.
  const score = work.score.subarray(0, n);
  let mid = from;
  for (let it = 0; it < ITERATIONS; it++) {
    let bias = 0;
    for (let k = 0; k < dims; k++) {
      const x = ca[k] as number;
      const y = cb[k] as number;
      w[k] = x - y;
      bias += (x * x - y * y) / 2;
    }
    for (let p = 0; p < n; p++)
      score[p] = dotRow(v, idx[from + p] as number, w) - bias;
    mid = from + partition(idx, score, from, n, 0);
    if (mid === from || mid === to) break;
    centroid(v, idx, from, mid, ca);
    centroid(v, idx, mid, to, cb);
  }
  // Too lopsided: cut at the median of the same direction, so each side
  // still holds what is nearer its own end.
  const small = Math.min(mid - from, to - mid);
  if (small < Math.max(1, Math.floor(n * MIN_SHARE))) {
    const sorted = work.sorted.subarray(0, n);
    sorted.set(score);
    sorted.sort();
    const median = sorted[Math.floor(n / 2)] as number;
    mid = from + partition(idx, score, from, n, median);
    if (mid === from || mid === to) mid = from + Math.floor(n / 2);
  }
  return mid;
}

/** Moves idx[from..from+n) with score >= threshold to the front, keeping
 * each score beside its member; returns how many there are. */
function partition(
  idx: Int32Array,
  score: Float32Array,
  from: number,
  n: number,
  threshold: number,
): number {
  let lo = 0;
  let hi = n - 1;
  while (lo <= hi) {
    if ((score[lo] as number) >= threshold) {
      lo++;
      continue;
    }
    const s = score[lo] as number;
    score[lo] = score[hi] as number;
    score[hi] = s;
    const m = idx[from + lo] as number;
    idx[from + lo] = idx[from + hi] as number;
    idx[from + hi] = m;
    hi--;
  }
  return lo;
}

/** Orders a leaf as a nearest-neighbour chain starting nearest `tail`. */
function chainLeaf(
  v: Vectors,
  idx: Int32Array,
  from: number,
  to: number,
  tail: Row | null,
): void {
  const left = Array.from(idx.subarray(from, to));
  const out: number[] = [];
  let current = -1;
  if (tail) {
    let high = Number.NEGATIVE_INFINITY;
    for (const j of left) {
      const s = dotRow(v, j, tail);
      if (s > high) {
        high = s;
        current = j;
      }
    }
  } else {
    current = left[0] as number;
  }
  while (left.length > 0) {
    left.splice(left.indexOf(current), 1);
    out.push(current);
    let high = Number.NEGATIVE_INFINITY;
    let next = -1;
    for (const j of left) {
      const s = dotRows(v, current, j);
      if (s > high) {
        high = s;
        next = j;
      }
    }
    current = next;
  }
  idx.set(out, from);
}

/** The map's groups: the tree's nodes of about 1/GROUPS of the board. */
const GROUPS = 16;

/** Row indices of `v` in map order (position p holds row order[p]), and
 * the group of each position: the first tree node on the way down no
 * bigger than 1/GROUPS of the board, numbered in map order. A group is a
 * run of the map, so it can be a section. */
export function arrange(v: Vectors): { order: Int32Array; group: Int32Array } {
  const idx = new Int32Array(v.count);
  for (let i = 0; i < v.count; i++) idx[i] = i;
  const group = new Int32Array(v.count);
  if (v.count <= 1) return { order: idx, group };
  const groupSize = Math.max(LEAF, Math.ceil(v.count / GROUPS));
  let groupCount = -1;
  let groupedUntil = 0;
  const work = workFor(v);
  // The tail is the last picture placed: the next block starts nearest it.
  let tail: Row | null = null;
  const row = (i: number) => v.data.subarray(i * v.dims, (i + 1) * v.dims);
  // Explicit stack of [from, to), taken last-in-first-out so ranges are
  // placed left to right.
  const stack: [number, number][] = [[0, v.count]];
  while (stack.length > 0) {
    const [from, to] = stack.pop() as [number, number];
    // Ranges come off the stack in map order, so the first small enough
    // that is not inside an earlier group starts the next group.
    if (from >= groupedUntil && to - from <= groupSize) {
      groupCount++;
      group.fill(groupCount, from, to);
      groupedUntil = to;
    }
    if (to - from <= LEAF) {
      chainLeaf(v, idx, from, to, tail);
      tail = row(idx[to - 1] as number);
      continue;
    }
    const mid = split(v, idx, from, to, work);
    // Put first the half whose centroid is nearer the tail.
    if (tail) {
      const first = centroid(v, idx, from, mid, work.ca);
      const second = centroid(v, idx, mid, to, work.cb);
      let a = 0;
      let b = 0;
      for (let k = 0; k < v.dims; k++) {
        a += (first[k] as number) * (tail[k] as number);
        b += (second[k] as number) * (tail[k] as number);
      }
      if (b > a) {
        // Rotate so [mid, to) comes before [from, mid).
        const head = work.held.subarray(0, mid - from);
        head.set(idx.subarray(from, mid));
        idx.copyWithin(from, mid, to);
        idx.set(head, from + (to - mid));
        const newMid = from + (to - mid);
        stack.push([newMid, to], [from, newMid]);
        continue;
      }
    }
    stack.push([mid, to], [from, mid]);
  }
  return { order: idx, group };
}

/** Mean similarity between each map cell and its neighbours to the right
 * (same row) and below, under `order`, on a map `cols` wide. */
export function neighbourSimilarity(
  v: Vectors,
  order: ArrayLike<number>,
  cols = 16,
): number {
  let sum = 0;
  let pairs = 0;
  for (let p = 0; p < order.length; p++) {
    const i = order[p] as number;
    if ((p + 1) % cols !== 0 && p + 1 < order.length) {
      sum += dotRows(v, i, order[p + 1] as number);
      pairs++;
    }
    if (p + cols < order.length) {
      sum += dotRows(v, i, order[p + cols] as number);
      pairs++;
    }
  }
  return pairs ? sum / pairs : 0;
}
