import { describe, expect, it } from 'vitest';
import { coverTone } from '../src/app/phone/cover-tone';

function fill(count: number, rgb: [number, number, number]): number[] {
  return Array.from({ length: count }, () => [...rgb, 255]).flat();
}

describe('coverTone', () => {
  it('takes the hue of a colourful cover', () => {
    const tone = coverTone(new Uint8ClampedArray(fill(100, [255, 110, 50])));
    expect(tone.chroma).toBeGreaterThan(0.1);
    expect(tone.hue).toBeGreaterThan(30);
    expect(tone.hue).toBeLessThan(60);
  });

  it('follows the colour that covers most, weighted by chroma', () => {
    const tone = coverTone(new Uint8ClampedArray([...fill(70, [30, 60, 160]), ...fill(30, [240, 200, 40])]));
    expect(tone.hue).toBeGreaterThan(250);
    expect(tone.hue).toBeLessThan(280);
  });

  it('goes neutral when only a few pixels have colour', () => {
    const tone = coverTone(new Uint8ClampedArray([...fill(95, [20, 20, 22]), ...fill(5, [200, 30, 30])]));
    expect(tone.chroma).toBe(0);
  });

  it('goes neutral for a grey cover', () => {
    expect(coverTone(new Uint8ClampedArray(fill(50, [128, 128, 128])))).toEqual({ hue: 0, chroma: 0 });
  });
});
