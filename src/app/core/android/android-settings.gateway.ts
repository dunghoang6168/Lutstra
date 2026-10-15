import { SettingsGateway } from '../contracts/settings.gateway';
import { MockSettingsGateway } from '../mock/mock-settings.gateway';
import { PlaybackSession, Settings } from '../models';

const SETTINGS_KEY = 'lutstra.android.settings';
const SESSION_KEY = 'lutstra.android.session';

function read<T>(key: string): T | null {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) as T : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Losing a save only costs the preference. */ }
}

/**
 * Settings and the playback session in the WebView's localStorage, which lives in the app's private data.
 * Validation is the browser mock's; music folders are managed by the folder picker, not here.
 */
export class AndroidSettingsGateway implements SettingsGateway {
  private readonly inner = new MockSettingsGateway();
  private readonly ready: Promise<Settings>;

  constructor() {
    // Media3 cannot crossfade, so crossfade starts off.
    this.ready = this.inner.saveSettings({ crossfadeEnabled: false, ...read<Partial<Settings>>(SETTINGS_KEY), musicFolders: [] });
  }

  async getSettings(): Promise<Settings> {
    await this.ready;
    return this.inner.getSettings();
  }

  async saveSettings(settings: Partial<Settings>): Promise<Settings> {
    await this.ready;
    const saved = await this.inner.saveSettings(settings);
    write(SETTINGS_KEY, saved);
    return saved;
  }

  async getSession(): Promise<PlaybackSession | null> { return read<PlaybackSession>(SESSION_KEY); }
  async saveSession(session: PlaybackSession): Promise<void> { write(SESSION_KEY, session); }
}
