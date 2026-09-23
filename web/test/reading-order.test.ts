import { describe, expect, test } from 'bun:test';
import { nextImage } from '../src/sheet/reading-order.ts';

const image = (id: string, x: number, y: number) => ({
  id,
  x,
  y,
  width: 100,
  height: 100,
  customData: { kind: 'image', imageId: id },
});

// Two rows; "b" sits 20 lower than "a" but is still in the first row.
const scene = [
  image('c', 0, 200),
  image('b', 150, 20),
  image('a', 0, 0),
  image('d', 150, 210),
  {
    id: 'r',
    x: 10,
    y: 10,
    width: 10,
    height: 10,
    customData: { kind: 'region', imageId: 'a', label: '', properties: {} },
  },
];

describe('nextImage', () => {
  test('walks rows top to bottom, left to right, and wraps', () => {
    const order: string[] = [];
    let at: string | null = null;
    for (let i = 0; i < 5; i++) {
      at = nextImage(scene, at, 1)?.id ?? null;
      if (at) order.push(at);
    }
    expect(order).toEqual(['a', 'b', 'c', 'd', 'a']);
  });

  test('Shift+Tab walks back, and starts from the last image', () => {
    expect(nextImage(scene, null, -1)?.id).toBe('d');
    expect(nextImage(scene, 'c', -1)?.id).toBe('b');
  });
});
