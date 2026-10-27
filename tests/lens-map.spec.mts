import { describe, expect, it } from 'vitest';
import { lensMapPixels } from '../src/app/shared/directives/lens-map';

const at = (pixels: Uint8ClampedArray, width: number, x: number, y: number) => {
  const k = (y * width + x) * 4;
  return [pixels[k], pixels[k + 1]];
};

describe('lens displacement map', () => {
  const w = 200, h = 60, pixels = lensMapPixels(w, h, 30, 20);

  it('leaves the centre neutral', () => {
    expect(at(pixels, w, 100, 30)).toEqual([128, 128]);
  });

  it('pushes samples inward at every edge, strongest at the rim', () => {
    expect(at(pixels, w, 100, 0)[1]).toBeGreaterThan(200); // top edge samples downward
    expect(at(pixels, w, 100, h - 1)[1]).toBeLessThan(56); // bottom edge samples upward
    expect(at(pixels, w, 100, 10)[1]).toBeLessThan(at(pixels, w, 100, 0)[1]); // weaker deeper in
    expect(at(pixels, w, 5, 30)[0]).toBeGreaterThan(128); // left cap samples rightward
    expect(at(pixels, w, 194, 30)[0]).toBeLessThan(128); // right cap samples leftward
  });

  it('keeps the outside of rounded corners neutral', () => {
    expect(at(pixels, w, 0, 0)).toEqual([128, 128]);
  });

  it('clamps a bezel wider than the box', () => {
    expect(() => lensMapPixels(10, 10, 100, 100)).not.toThrow();
  });
});
