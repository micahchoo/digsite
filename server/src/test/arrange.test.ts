import { describe, expect, test } from 'bun:test';
// meaning/arrange.ts, pure: pictures from the same group end up as a block
// on the 16-wide map, so neighbours across and down are near in meaning.
import {
  type Vectors,
  arrange,
  neighbourSimilarity,
} from '../meaning/arrange.ts';

/** `groups` groups of `each` unit vectors around random centres, dealt in
 * a shuffled order. A seeded generator keeps the test repeatable. */
function clustered(
  groups: number,
  each: number,
  dims = 64,
): {
  v: Vectors;
  group: number[];
} {
  let seed = 7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648 - 0.5;
  };
  const centres = Array.from({ length: groups }, () =>
    Array.from({ length: dims }, rand),
  );
  const members: { g: number; x: number[] }[] = [];
  for (let g = 0; g < groups; g++) {
    for (let i = 0; i < each; i++) {
      members.push({
        g,
        x: (centres[g] as number[]).map((c) => c + rand() * 0.6),
      });
    }
  }
  members.sort(() => rand());
  const data = new Float32Array(members.length * dims);
  members.forEach(({ x }, i) => {
    const norm = Math.hypot(...x);
    data.set(
      x.map((c) => c / norm),
      i * dims,
    );
  });
  return {
    v: { data, count: members.length, dims },
    group: members.map((m) => m.g),
  };
}

describe('arrange', () => {
  test('every picture placed exactly once, at any size', () => {
    for (const n of [0, 1, 2, 16, 17, 250]) {
      const { v } = clustered(1, n);
      const order = arrange(v);
      expect([n, new Set(order).size]).toEqual([n, n]);
    }
  });

  test('a group becomes a block: neighbours across and down share it', () => {
    const { v, group } = clustered(6, 60);
    const order = arrange(v);
    const shuffled = Int32Array.from({ length: v.count }, (_, i) => i);
    const sameGroup = (o: ArrayLike<number>) => {
      let same = 0;
      let pairs = 0;
      for (let p = 0; p < o.length; p++) {
        for (const q of [p + 1, p + 16]) {
          if (q >= o.length || (q === p + 1 && q % 16 === 0)) continue;
          pairs++;
          if (group[o[p] as number] === group[o[q] as number]) same++;
        }
      }
      return same / pairs;
    };
    // Dealt at random, about one neighbour pair in six shares a group.
    expect(sameGroup(shuffled)).toBeLessThan(0.3);
    expect(sameGroup(order)).toBeGreaterThan(0.85);
    expect(neighbourSimilarity(v, order)).toBeGreaterThan(
      neighbourSimilarity(v, shuffled) + 0.2,
    );
  });
});
