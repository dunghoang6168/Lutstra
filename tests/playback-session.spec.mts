import '@angular/compiler';
import { describe, expect, it, vi } from 'vitest';
import { Injector, runInInjectionContext } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';
import { validPlaybackSession } from '../electron/ipc/settings-validation';
import { LIBRARY_GATEWAY, PLAYBACK_ENGINE, SETTINGS_GATEWAY } from '../src/app/core/contracts';
import type { PlaybackSession, Track } from '../src/app/core/models';
import { ExternalSource, PlayerService } from '../src/app/core/player/player.service';

const track = (id: string): Track => ({
  id, path: `/music/${id}.flac`, fileName: `${id}.flac`, title: id,
  artist: null, albumArtist: null, album: null, genre: null, year: null,
  trackNumber: null, discNumber: null, duration: 180, codec: 'FLAC', bitrate: null,
  sampleRate: 44100, bitDepth: 16, channels: 2, artwork: null, fileSize: null,
  lastModified: null, isAvailable: true,
});

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };

function setup(session: PlaybackSession | null, libraryIds = ['a', 'b', 'c', 'd']) {
  const engine: any = {
    stateChange$: new BehaviorSubject<any>({ state: 'idle', track: null }), timeUpdate$: new Subject(), volumeChange$: new Subject(),
    outputInterrupted$: new Subject(), subscribeDeviceChanges: () => () => undefined,
    setBackend: vi.fn(async () => undefined), getBackend: () => 'chromium', setOutputMode: vi.fn(async () => undefined),
    setOutputFallbackEnabled: vi.fn(), setVolume: vi.fn(), setMute: vi.fn(), cancelPreparedNext: vi.fn(),
    prepareNext: vi.fn(async () => false), listOutputDevices: async () => [], getAudioPathStatus: async () => null,
    selectOutputDevice: vi.fn(async () => undefined), pause: vi.fn(), play: vi.fn(async () => undefined), dispose: vi.fn(),
    load: vi.fn(async () => undefined), seek: vi.fn(), transitionTo: vi.fn(async () => true),
  };
  const gateway = {
    getSettings: async () => ({}), saveSettings: vi.fn(async (value: any) => value),
    getSession: async () => session, saveSession: vi.fn(async () => undefined),
  };
  const library = { getLibrary: async () => ({ tracks: libraryIds.map(track) }), scanProgress$: new Subject() };
  const injector = Injector.create({ providers: [
    { provide: PLAYBACK_ENGINE, useValue: engine }, { provide: SETTINGS_GATEWAY, useValue: gateway }, { provide: LIBRARY_GATEWAY, useValue: library },
  ] });
  const player = runInInjectionContext(injector, () => new PlayerService());
  return { player, engine, gateway };
}

const ids = (player: PlayerService) => player.queue().map((entry) => entry.track.id);
const save = (player: PlayerService) => (player as any).saveSession();

describe('playback session', () => {
  it('restores the queue paused at the saved position, without playing', async () => {
    const { player, engine } = setup({ version: 1, trackIds: ['c', 'a', 'b'], originalOrder: [1, 2, 0], currentIndex: 1, positionSeconds: 42 });
    await flush();
    expect(ids(player)).toEqual(['c', 'a', 'b']);
    expect(player.currentTrack()?.id).toBe('a');
    expect(player.playbackState()).toBe('paused');
    expect(engine.seek).toHaveBeenCalledWith(42);
    expect(engine.play).not.toHaveBeenCalled();
    expect((player as any).originalQueue.map((entry: any) => entry.track.id)).toEqual(['a', 'b', 'c']);
    player.ngOnDestroy();
  });

  it('drops tracks gone from the library and moves past a missing current track from the start', async () => {
    const { player, engine } = setup({ version: 1, trackIds: ['a', 'x', 'b'], originalOrder: [0, 1, 2], currentIndex: 1, positionSeconds: 42 }, ['a', 'b']);
    await flush();
    expect(ids(player)).toEqual(['a', 'b']);
    expect(player.currentTrack()?.id).toBe('b');
    expect(engine.seek).not.toHaveBeenCalled();
    player.ngOnDestroy();
  });

  it('saves the queue, the original order and the position', async () => {
    const { player, gateway } = setup(null);
    await flush();
    await player.playCollection([track('a'), track('b'), track('c')], 1);
    player.currentTime.set(30.7);
    save(player);
    expect(gateway.saveSession).toHaveBeenLastCalledWith({ version: 1, trackIds: ['a', 'b', 'c'], originalOrder: [0, 1, 2], currentIndex: 1, positionSeconds: 30 });

    // While playing, a moving position is saved at most every 5 seconds.
    player.playbackState.set('playing');
    player.currentTime.set(32);
    save(player);
    expect(gateway.saveSession).toHaveBeenCalledTimes(1);
    player.ngOnDestroy();
  });

  it('keeps the parked queue and its resume point while the roulette plays', async () => {
    const { player, gateway } = setup(null);
    await flush();
    await player.playCollection([track('a'), track('b')], 1);
    player.currentTime.set(60);
    const roulette: ExternalSource = { next: () => null, peek: () => null, previous: () => null };
    await player.playExternal(roulette, track('x'));
    player.currentTime.set(5);
    save(player);
    expect(gateway.saveSession).toHaveBeenLastCalledWith(expect.objectContaining({ trackIds: ['a', 'b'], currentIndex: 1, positionSeconds: 60 }));
    player.ngOnDestroy();
  });

  it('validates sessions from the renderer', () => {
    const id = (c: string) => `track-${c.repeat(64)}`;
    const valid = { version: 1, trackIds: [id('a'), id('b')], originalOrder: [1, 0], currentIndex: -1, positionSeconds: 0 };
    expect(validPlaybackSession(valid)).toEqual(valid);
    for (const bad of [
      null, [], { ...valid, trackIds: id('a') }, { ...valid, trackIds: ['a', 'b'] }, { ...valid, originalOrder: [0, 0] }, { ...valid, originalOrder: [0] },
      { ...valid, currentIndex: 2 }, { ...valid, currentIndex: 0.5 }, { ...valid, positionSeconds: -1 }, { ...valid, positionSeconds: Infinity },
      { ...valid, trackIds: Array.from({ length: 10001 }, () => id('c')), originalOrder: [] },
    ]) expect(() => validPlaybackSession(bad)).toThrow();
  });
});
