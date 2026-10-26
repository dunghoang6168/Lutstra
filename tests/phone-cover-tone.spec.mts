import { describe, expect, it } from 'vitest';
import { coverTone, nowPlayingTones } from '../src/app/phone/cover-tone';

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

describe('nowPlayingTones', () => {
  it('caps each role at its own chroma, at a fixed lightness', () => {
    const tones = nowPlayingTones({ hue: 96, chroma: 0.118 }, 'dark');
    expect(tones['--np-ink']).toBe('oklch(0.94 0.035 96)');
    expect(tones['--np-on']).toBe('oklch(0.8 0.118 96)');
    expect(tones['--np-on-muted']).toBe('oklch(0.8 0.118 96 / 0.15)');
  });

  it('turns grey with a grey cover and darkens for the light theme', () => {
    expect(nowPlayingTones({ hue: 0, chroma: 0 }, 'dark')['--np-play']).toBe('oklch(0.86 0 0)');
    expect(nowPlayingTones({ hue: 243, chroma: 0.093 }, 'light')['--np-on']).toBe('oklch(0.45 0.093 243)');
  });
});
