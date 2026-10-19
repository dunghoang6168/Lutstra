import '@angular/compiler';
import { describe, expect, it, vi } from 'vitest';
import { Injector } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';
import { LIBRARY_GATEWAY, LISTENING_HISTORY_GATEWAY, PLAYBACK_ENGINE, PLAYLIST_GATEWAY, SETTINGS_GATEWAY } from '../src/app/core/contracts';
import { MockLibraryGateway, MockListeningHistoryGateway, MockPlaylistGateway } from '../src/app/core/mock';
import { PlayerService } from '../src/app/core/player/player.service';
import { ListeningHistoryService } from '../src/app/core/history/listening-history.service';
import { SmartShuffleService } from '../src/app/core/smart-shuffle/smart-shuffle.service';

// Effects are driven by hand: `arrange()` is what the queue effect schedules.
vi.mock('@angular/core', async (importOriginal) => ({
  ...await importOriginal<typeof import('@angular/core')>(),
  effect: vi.fn(() => ({ destroy: vi.fn() })),
}));

async function setup() {
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
  const library = new MockLibraryGateway();
  const injector = Injector.create({ providers: [
    { provide: PLAYBACK_ENGINE, useValue: engine }, { provide: SETTINGS_GATEWAY, useValue: settings },
    { provide: LIBRARY_GATEWAY, useValue: library }, { provide: LISTENING_HISTORY_GATEWAY, useValue: new MockListeningHistoryGateway() },
    { provide: PLAYLIST_GATEWAY, useValue: new MockPlaylistGateway() },
    ...[PlayerService, ListeningHistoryService, SmartShuffleService].map((type) => ({ provide: type, useFactory: () => new type(), deps: [] })),
  ] });
  const player = injector.get(PlayerService);
  const history = injector.get(ListeningHistoryService);
  const service = injector.get(SmartShuffleService);
  service.random = (() => { let seed = 3; return () => ((seed = (seed * 16807) % 2147483647) / 2147483647); })();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const tracks = (await library.getLibrary()).tracks.filter((track) => track.isAvailable);
  const turnOn = async () => { await service.cycleShuffle(); await service.cycleShuffle(); };
  const arrange = () => (service as any).arrange() as Promise<void>;
  const autoplay = () => (service as any).autoplay() as Promise<void>;
  const playing = () => engine.stateChange$.next({ state: 'playing', track: player.currentTrack() });
  return { player, history, service, tracks, arrange, turnOn, autoplay, playing };
}

describe('SmartShuffleService', () => {
  it('steps the one playback-mode button through Smart Shuffle after Shuffle', async () => {
    const { player, service, tracks } = await setup();
    await player.playCollection(tracks.slice(0, 3), 0);
    const seen: string[] = [];
    for (let i = 0; i < 5; i++) {
      await service.cyclePlaybackMode();
      seen.push(player.playbackMode());
    }
    expect(seen).toEqual(['shuffle', 'smart-shuffle', 'repeat-all', 'repeat-one', 'off']);
    expect(player.playbackModeIcon()).toBe('repeat');
  });

  it('starts playing suggestions when the shuffle cycle reaches Smart Shuffle with nothing queued', async () => {
    const { player, service } = await setup();
    await service.cycleShuffle();
    expect(player.isShuffle()).toBe(true);
    expect(player.queue()).toEqual([]);
    await service.cycleShuffle();
    expect(player.smartShuffle()).toBe(true);
    expect(player.queue().length).toBe(10);
    expect(player.queue().every((entry) => entry.suggested)).toBe(true);
    expect(player.currentIndex()).toBe(0);
    expect(new Set(player.queue().map((entry) => entry.track.id)).size).toBe(10);
  });

  it('mixes suggestions into the user queue and takes them out again when turned off', async () => {
    const { player, service, tracks, arrange, turnOn } = await setup();
    const own = tracks.slice(0, 8);
    await player.playCollection(own, 0);
    await turnOn();
    await arrange();
    const queue = player.queue();
    expect(queue.filter((entry) => !entry.suggested).map((entry) => entry.track.id).sort()).toEqual(own.map((track) => track.id).sort());
    expect(queue.slice(0, 11).some((entry) => entry.suggested)).toBe(true);
    expect(queue[0].track.id).toBe(own[0].id);

    await service.cycleShuffle();
    expect(player.smartShuffle()).toBe(false);
    expect(player.isShuffle()).toBe(false);
    expect(player.queue().map((entry) => entry.track.id)).toEqual(own.map((track) => track.id));
  });

  it('remembers a removed suggestion and rebuilds the tentative ones', async () => {
    const { player, history, service, tracks, arrange, turnOn } = await setup();
    await player.playCollection(tracks.slice(0, 4), 0);
    await turnOn();
    await arrange();
    const suggestion = player.queue().find((entry, index) => entry.suggested && index > 1)!;
    expect(suggestion).toBeDefined();
    history.recordRemoval(suggestion.track);
    player.removeFromQueue(suggestion.id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await arrange();
    expect(player.queue().some((entry) => entry.track.id === suggestion.track.id)).toBe(false);
    expect((service as any).sessionExclude.has(suggestion.track.id)).toBe(true);
  });

  it('stays out of the way while the roulette plays', async () => {
    const { player, service } = await setup();
    vi.spyOn(player, 'modesLocked').mockReturnValue(true);
    await service.cycleShuffle();
    await service.cyclePlaybackMode();
    expect(player.isShuffle()).toBe(false);
    expect(player.smartShuffle()).toBe(false);
  });
});

describe('Autoplay', () => {
  it('is on by default and adds nothing once turned off', async () => {
    const { player, tracks, autoplay, playing } = await setup();
    expect(player.autoplay()).toBe(true);
    player.setAutoplay(false);
    await player.playCollection(tracks.slice(0, 2), 1);
    playing();
    await autoplay();
    expect(player.queue().length).toBe(2);
  });

  it('queues suggestions once the last entry plays, after the user tracks in their order', async () => {
    const { player, tracks, autoplay, playing } = await setup();
    player.autoplay.set(true);
    const own = tracks.slice(0, 3);
    await player.playCollection(own, 0);
    playing();
    await autoplay();
    expect(player.queue().length).toBe(3);

    await player.jumpToQueueIndex(2);
    playing();
    await autoplay();
    const queue = player.queue();
    expect(queue.slice(0, 3).map((entry) => entry.track.id)).toEqual(own.map((track) => track.id));
    expect(queue.slice(3).length).toBe(5);
    expect(queue.slice(3).every((entry) => entry.suggested)).toBe(true);
    expect(new Set(queue.map((entry) => entry.track.id)).size).toBe(8);
  });

  it('stays off with Smart Shuffle, repeat, the setting off or while paused', async () => {
    const { player, tracks, autoplay, playing } = await setup();
    player.autoplay.set(true);
    await player.playCollection(tracks.slice(0, 2), 1);
    await autoplay();
    expect(player.queue().length).toBe(2);
    playing();
    player.setRepeatMode('all');
    await autoplay();
    player.setRepeatMode('off');
    player.setAutoplay(false);
    await autoplay();
    expect(player.queue().length).toBe(2);
  });

  it('drops the suggestions not played yet when turned off', async () => {
    const { player, tracks, autoplay, playing } = await setup();
    player.autoplay.set(true);
    await player.playCollection(tracks.slice(0, 2), 1);
    playing();
    await autoplay();
    await player.jumpToQueueIndex(2);
    player.setAutoplay(false);
    expect(player.queue().length).toBe(3);
    expect(player.currentIndex()).toBe(2);
  });

  it('puts Add to queue before its suggestions and keeps them last through shuffle', async () => {
    const { player, tracks, autoplay, playing } = await setup();
    player.autoplay.set(true);
    const own = tracks.slice(0, 3);
    await player.playCollection(own, 2);
    playing();
    await autoplay();
    player.addToQueue([tracks[10]]);
    expect(player.queue()[3].track.id).toBe(tracks[10].id);
    expect(player.queue().slice(4).every((entry) => entry.suggested)).toBe(true);

    player.toggleShuffle();
    expect(player.queue().slice(-5).every((entry) => entry.suggested)).toBe(true);
    player.toggleShuffle();
    expect(player.queue().slice(0, 4).map((entry) => entry.track.id)).toEqual([...own, tracks[10]].map((track) => track.id));
    expect(player.queue().slice(4).every((entry) => entry.suggested)).toBe(true);
    expect(player.currentIndex()).toBe(2);
  });
});
