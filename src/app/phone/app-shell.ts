import { signal } from '@angular/core';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { DynamicPalette } from '../core/theme/dynamic-accent';
import { formatKhz } from '../features/home/library-quality';

/** A gesture's phases, as Android's HapticFeedbackConstants name them (PixelPlayer uses the same ones). */
export type HapticKind = 'tick' | 'start' | 'end' | 'activate' | 'deactivate';

/** The native shell services (`AppShellPlugin` in MainActivity). */
export const appShell = registerPlugin<{
  moveToBack(): Promise<void>;
  getDynamicColors(): Promise<{ palette: DynamicPalette }>;
  haptic(options: { kind: HapticKind }): Promise<void>;
  getOutputInfo(): Promise<{ sampleRate: number | null }>;
}>('AppShell');

/**
 * The rate Android's mixer runs the primary output at. Every app's audio is resampled to it, so the phone is
 * never bit-perfect; Now Playing and File info say so. Null until read, or off Android.
 */
export const mixerRate = signal<number | null>(null);

export async function loadMixerRate(): Promise<void> {
  if (Capacitor.getPlatform() !== 'android') return;
  try { mixerRate.set((await appShell.getOutputInfo()).sampleRate); } catch { mixerRate.set(null); }
}

/** The mixer's rate in kHz, and whether a file at `fileRate` is resampled to reach it; null when the rate is unknown. */
export function outputPath(fileRate: number | null, mixer: number | null): { khz: string; resampled: boolean } | null {
  return mixer ? { khz: formatKhz(mixer), resampled: !!fileRate && fileRate !== mixer } : null;
}
