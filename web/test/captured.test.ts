// What the camera wrote, said the way a person reads it (board/captured.ts).
import { describe, expect, test } from 'bun:test';
import { captured, exposure, isCaptured } from '../src/board/captured.ts';

describe('captured', () => {
  test('one camera line from the separate fields, in the order a photographer says them', () => {
    expect(
      captured({
        camera: 'Canon EOS R5',
        lens: 'RF35mm F1.8',
        focal_mm: 35,
        aperture: 2.8,
        exposure_s: 0.004,
        iso: 400,
      }).camera,
    ).toBe('Canon EOS R5 · RF35mm F1.8 · 35 mm · f/2.8 · 1/250 s · ISO 400');
  });

  test('the time is the camera clock, to the second, with no zone added', () => {
    const { taken } = captured({ taken_at: '2021-03-12T14:03:22' });
    expect(taken).toContain('2021');
    expect(taken).toContain('14:03:22');
  });

  test('a place needs both coordinates', () => {
    expect(captured({ latitude: 51.5 }).place).toBeNull();
    expect(captured({ latitude: 51.5, longitude: -0.12 }).place).toEqual({
      latitude: 51.5,
      longitude: -0.12,
    });
  });

  test('a picture with nothing from the camera has nothing to show', () => {
    expect(captured({ site: 'x' })).toEqual({
      camera: null,
      taken: null,
      place: null,
    });
    expect(isCaptured('site')).toBe(false);
    expect(isCaptured('iso')).toBe(true);
  });

  test('shutter times read as fractions below half a second', () => {
    expect(exposure(1 / 60)).toBe('1/60 s');
    expect(exposure(2)).toBe('2 s');
  });
});
