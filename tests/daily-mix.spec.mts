import '@angular/compiler';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Injector } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';
import { LIBRARY_GATEWAY, LISTENING_HISTORY_GATEWAY, PLAYBACK_ENGINE, PLAYLIST_GATEWAY, SETTINGS_GATEWAY } from '../src/app/core/contracts';
import { MockLibraryGateway, MockListeningHistoryGateway, MockPlaylistGateway } from '../src/app/core/mock';
import { PlayerService } from '../src/app/core/player/player.service';
import { ListeningHistoryService } from '../src/app/core/history/listening-history.service';
import { SmartShuffleService } from '../src/app/core/smart-shuffle/smart-shuffle.service';
import { Track } from '../src/app/core/models';
import { DAILY_MIX_KEY, DailyMixService, isMixQueue, localDay, parseDailyMix } from '../src/app/core/smart-shuffle/daily-mix.service';

vi.mock('@angular/core', async (importOriginal) => ({
  ...await importOriginal<typeof import('@angular/core')>(),
  effect: vi.fn(() => ({ destroy: vi.fn() })),
}));

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
});

function setup() {
  const engine: any = {
    stateChange$: new BehaviorSubject<any>({ state: 'idle', track: null }), timeUpdate$: new Subject(), volumeChange$: new Subject(),
    outputInterrupted$: new Subject(), subscribeDeviceChanges: () => () => undefined,
    setBackend: vi.fn(async () => undefined), getBackend: () => 'chromium', setOutputMode: vi.fn(async () => undefined),
    setOutputFallbackEnabled: vi.fn(), setVolume: vi.fn(), setMute: vi.fn(), cancelPreparedNext: vi.fn(),
    prepareNext: vi.fn(async () => false), listOutputDevices: async () => [], getAudioPathStatus: async () => null,
    selectOutputDevice: vi.fn(async () => undefined), pause: vi.fn(), play: vi.fn(async () => undefined), dispose: vi.fn(),
    load: vi.fn(async () => undefined), seek: vi.fn(), transitionTo: vi.fn(async () => true),
  };
  const settings = { getSettings: async () => ({}), saveSettings: vi.fn(async (value: any) => value) };
  const historyGateway = new MockListeningHistoryGateway();
  const injector = Injector.create({ providers: [
    { provide: PLAYBACK_ENGINE, useValue: engine }, { provide: SETTINGS_GATEWAY, useValue: settings },
    { provide: LIBRARY_GATEWAY, useValue: new MockLibraryGateway() }, { provide: LISTENING_HISTORY_GATEWAY, useValue: historyGateway },
    { provide: PLAYLIST_GATEWAY, useValue: new MockPlaylistGateway() },
    ...[PlayerService, ListeningHistoryService, SmartShuffleService, DailyMixService].map((type) => ({ provide: type, useFactory: () => new type(), deps: [] })),
  ] });
  return { player: injector.get(PlayerService), mix: injector.get(DailyMixService), historyGateway };
}

describe('DailyMixService', () => {
  afterEach(() => { store.clear(); vi.useRealTimers(); });

  it('makes one mix a day, keeps it through a restart and plays exactly it', async () => {
    const { mix, player } = setup();
    await mix.ensure();
    const first = mix.tracks().map((track) => track.id);
    expect(first.length).toBeGreaterThan(0);
    expect(new Set(first).size).toBe(first.length);
    expect(parseDailyMix(store.get(DAILY_MIX_KEY)!)).toEqual({ day: localDay(Date.now()), trackIds: first });

    const restarted = setup().mix;
    await restarted.ensure();
    expect(restarted.tracks().map((track) => track.id)).toEqual(first);

    player.setSmartShuffle(true);
    await mix.play(2);
    expect(player.smartShuffle()).toBe(false);
    expect(player.queue().map((entry) => entry.track.id)).toEqual(first);
    expect(player.queue().some((entry) => entry.suggested)).toBe(false);
    expect(player.currentIndex()).toBe(2);
  });

  it('starts over on a new day', async () => {
    store.set(DAILY_MIX_KEY, JSON.stringify({ day: '2000-1-1', trackIds: ['gone'] }));
    const { mix } = setup();
    await mix.ensure();
    expect(mix.tracks().length).toBeGreaterThan(0);
    expect(parseDailyMix(store.get(DAILY_MIX_KEY)!)?.day).toBe(localDay(Date.now()));
  });

  it('records a removed track as a mild dislike and saves the shorter mix', async () => {
    const { mix, historyGateway } = setup();
    await mix.ensure();
    const [removed, ...rest] = mix.tracks();
    mix.remove(removed);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(parseDailyMix(store.get(DAILY_MIX_KEY)!)?.trackIds).toEqual(rest.map((track) => track.id));
    expect((await historyGateway.events()).at(-1)).toMatchObject({ trackId: removed.id, endReason: 'removed' });
  });

  it('ignores a malformed save', () => {
    expect(parseDailyMix('{"day":1}')).toBeNull();
    expect(parseDailyMix('nope')).toBeNull();
    expect(parseDailyMix(null)).toBeNull();
  });
});

describe('isMixQueue', () => {
  const t = (id: string) => ({ id }) as Track;
  const e = (id: string, suggested = false) => ({ id: 'e-' + id, track: t(id), originalIndex: 0, suggested });
  const mix = [t('a'), t('b'), t('c')];

  it('sees the mix in any order, past suggestions and tracks the user added', () => {
    expect(isMixQueue([e('c'), e('s1', true), e('a'), e('b'), e('x')], mix)).toBe(true);
  });

  it('is off once a mix track leaves the queue, for a suggested copy, or with no mix', () => {
    expect(isMixQueue([e('a'), e('b')], mix)).toBe(false);
    expect(isMixQueue([e('a'), e('b'), e('c', true)], mix)).toBe(false);
    expect(isMixQueue([e('a')], [])).toBe(false);
  });
});
