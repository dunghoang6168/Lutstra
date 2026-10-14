import { Injectable } from '@angular/core';
import { SettingsGateway } from '../contracts';
import { PlaybackSession, Settings } from '../models';
import { getDesktopApi } from './desktop-api';

@Injectable()
export class ElectronSettingsGateway implements SettingsGateway {
  private readonly api = getDesktopApi();
  private requireApi() { if (!this.api) throw new Error('Electron desktop API is unavailable'); return this.api; }
  getSettings(): Promise<Settings> { return this.requireApi().settings.get(); }
  saveSettings(settings: Partial<Settings>): Promise<Settings> { return this.requireApi().settings.save(settings); }
  getSession(): Promise<PlaybackSession | null> { return this.requireApi().settings.getSession(); }
  saveSession(session: PlaybackSession): Promise<void> { return this.requireApi().settings.saveSession(session); }
}
