import { Injectable, signal } from '@angular/core';

export const DEV_MODE_KEY = 'lutsra.dev.enabled';
/** The one unlock code, documented in docs/APP_GUIDE.md: it stops accidental unlocks, it is not a secret. */
export const DEV_MODE_CODE = 'lutstra-dev';

/** Hidden developer mode: unlocked with a code from the About heading in Settings, left from the About card. */
@Injectable({ providedIn: 'root' })
export class DevModeService {
  readonly enabled = signal(readEnabled());

  /** Turns developer mode on when the code matches (case and outer spaces ignored). */
  unlock(code: string): boolean {
    if (code.trim().toLowerCase() !== DEV_MODE_CODE) return false;
    this.set(true);
    return true;
  }

  disable(): void {
    this.set(false);
  }

  private set(enabled: boolean): void {
    this.enabled.set(enabled);
    try {
      localStorage.setItem(DEV_MODE_KEY, String(enabled));
    } catch {
      // Storage blocked: developer mode lasts for this session only.
    }
  }
}

function readEnabled(): boolean {
  try {
    return localStorage.getItem(DEV_MODE_KEY) === 'true';
  } catch {
    return false;
  }
}
