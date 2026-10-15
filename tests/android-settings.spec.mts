import '@angular/compiler';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AndroidSettingsGateway } from '../src/app/core/android/android-settings.gateway';
import { PlaybackSession } from '../src/app/core/models';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, String(value)); },
  };
}

describe('Android settings gateway', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('starts with crossfade off and keeps settings and the session across restarts', async () => {
    vi.stubGlobal('localStorage', memoryStorage());
    const first = new AndroidSettingsGateway();
    expect((await first.getSettings()).crossfadeEnabled).toBe(false);
    expect((await first.getSettings()).musicFolders).toEqual([]);
    await first.saveSettings({ defaultVolume: 0.35, crossfadeEnabled: true });
    await first.saveSession({ positionSeconds: 42 } as unknown as PlaybackSession);

    const restarted = new AndroidSettingsGateway();
    const settings = await restarted.getSettings();
    expect(settings.defaultVolume).toBe(0.35);
    expect(settings.crossfadeEnabled).toBe(true);
    expect(await restarted.getSession()).toEqual({ positionSeconds: 42 });
  });
});
