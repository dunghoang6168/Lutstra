import { Capacitor } from '@capacitor/core';
import { HapticKind, appShell } from './app-shell';

export type { HapticKind } from './app-shell';

/** A short buzz through the system's haptic feedback, which follows the phone's touch-vibration setting. */
export function haptic(kind: HapticKind): void {
  if (Capacitor.getPlatform() === 'android') appShell.haptic({ kind }).catch(() => undefined);
}
