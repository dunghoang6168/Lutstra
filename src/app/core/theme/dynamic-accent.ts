import { ThemePreset } from '../models';

/** Android's system_accent1 tones (Material You), keyed by tone: 10 is near white, 1000 is black. */
export type DynamicPalette = Partial<Record<number, string>>;

/** The accent tokens a preset defines (`html[data-accent]` in `_themes.scss`), filled from the wallpaper palette. */
export type AccentTokens = Record<
  '--color-accent' | '--color-accent-hover' | '--color-accent-active' | '--color-accent-muted' | '--color-accent-glow'
  | '--color-text-accent' | '--color-accent-fill' | '--color-accent-fill-hover' | '--color-on-accent', string>;

/** Accent text must stay readable on the darkest surface it sits on, as `check-accent-contrast.mjs` requires. */
export const ACCENT_TEXT_CONTRAST = 4.5;

/**
 * Picks the tones like the fixed accents: light tones on dark, dark tones on light. Text tones step further from
 * the surface until they reach ACCENT_TEXT_CONTRAST; the on-accent colour is whichever of black or white reads
 * better on the fill. Null when the palette lacks the tones.
 */
export function dynamicAccentTokens(palette: DynamicPalette, theme: ThemePreset, surfaces: string[]): AccentTokens | null {
  const dark = theme === 'dark';
  const [accent, hover, active] = (dark ? [200, 300, 400] : [600, 700, 800]).map((tone) => palette[tone]);
  if (!accent || !hover || !active) return null;
  const textTones = dark ? [200, 100, 50, 10] : [700, 800, 900];
  const text = textTones.map((tone) => palette[tone]).find((color) => color && surfaces.every((surface) => contrast(color, surface) >= ACCENT_TEXT_CONTRAST));
  if (!text) return null;
  const onAccent = contrast('#000000', accent) >= contrast('#ffffff', accent) ? '#111214' : '#ffffff';
  return {
    '--color-accent': accent,
    '--color-accent-hover': hover,
    '--color-accent-active': active,
    '--color-accent-muted': withAlpha(accent, dark ? 0.15 : 0.12),
    '--color-accent-glow': withAlpha(accent, dark ? 0.35 : 0.25),
    '--color-text-accent': text,
    '--color-accent-fill': accent,
    '--color-accent-fill-hover': hover,
    '--color-on-accent': onAccent,
  };
}

/** WCAG contrast ratio of two #rrggbb colours. */
export function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function rgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.replace('#', '').slice(0, 6), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function withAlpha(hex: string, alpha: number): string {
  return `rgba(${rgb(hex).join(', ')}, ${alpha})`;
}
