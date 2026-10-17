import { Capacitor, registerPlugin } from '@capacitor/core';

/** A gesture's phases, as Android's HapticFeedbackConstants name them (PixelPlayer uses the same ones). */
export type HapticKind = 'tick' | 'start' | 'end' | 'activate' | 'deactivate';

const shell = registerPlugin<{ haptic(options: { kind: HapticKind }): Promise<void> }>('AppShell');

/** A short buzz through the system's haptic feedback, which follows the phone's touch-vibration setting. */
export function haptic(kind: HapticKind): void {
  if (Capacitor.getPlatform() === 'android') shell.haptic({ kind }).catch(() => undefined);
}
