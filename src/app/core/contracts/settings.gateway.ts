import { InjectionToken } from '@angular/core';
import { PlaybackSession, Settings } from '../models';

export interface SettingsGateway {
  getSettings(): Promise<Settings>;
  saveSettings(settings: Partial<Settings>): Promise<Settings>;
  /** The queue and position from the last run, or null. */
  getSession(): Promise<PlaybackSession | null>;
  saveSession(session: PlaybackSession): Promise<void>;
}

export const SETTINGS_GATEWAY = new InjectionToken<SettingsGateway>('SETTINGS_GATEWAY');
