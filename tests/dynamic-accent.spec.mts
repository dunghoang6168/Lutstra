import { describe, expect, it } from 'vitest';
import { ACCENT_TEXT_CONTRAST, contrast, dynamicAccentTokens } from '../src/app/core/theme/dynamic-accent';

// A blue Material You palette as Android 14 reports it for a blue wallpaper.
const palette = {
  10: '#fafcff', 50: '#e6f1ff', 100: '#d1e4ff', 200: '#9fcaff', 300: '#6eb0f6', 400: '#5295d9',
  500: '#347bbd', 600: '#0b62a2', 700: '#004a7d', 800: '#003258', 900: '#001d36',
};
const darkSurfaces = ['#0d0f17', '#171a27', '#1e2235'];
const lightSurfaces = ['#f1f4f8', '#ffffff', '#f8fafc'];

describe('dynamic accent tokens', () => {
  it('uses light tones on dark and dark tones on light, with readable accent text', () => {
    const dark = dynamicAccentTokens(palette, 'dark', darkSurfaces)!;
    expect(dark['--color-accent']).toBe('#9fcaff');
    expect(dark['--color-on-accent']).toBe('#111214');
    expect(darkSurfaces.every((s) => contrast(dark['--color-text-accent'], s) >= ACCENT_TEXT_CONTRAST)).toBe(true);
    expect(dark['--color-accent-muted']).toBe('rgba(159, 202, 255, 0.15)');

    const light = dynamicAccentTokens(palette, 'light', lightSurfaces)!;
    expect(light['--color-accent']).toBe('#0b62a2');
    expect(light['--color-on-accent']).toBe('#ffffff');
    expect(lightSurfaces.every((s) => contrast(light['--color-text-accent'], s) >= ACCENT_TEXT_CONTRAST)).toBe(true);
  });

  it('steps the text tone further out when the first one is too faint', () => {
    const pale = { ...palette, 700: '#7aa7d0' };
    expect(dynamicAccentTokens(pale, 'light', lightSurfaces)!['--color-text-accent']).toBe('#003258');
  });

  it('gives up on a palette without the tones it needs', () => {
    expect(dynamicAccentTokens({ 200: '#9fcaff' }, 'dark', darkSurfaces)).toBeNull();
  });
});
