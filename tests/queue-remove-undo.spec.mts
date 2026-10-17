import '@angular/compiler';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Injector, runInInjectionContext } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';
import { PLAYBACK_ENGINE, SETTINGS_GATEWAY } from '../src/app/core/contracts';
import type { Track } from '../src/app/core/models';
import { PlayerService } from '../src/app/core/player/player.service';
import { QueueActionsService } from '../src/app/core/player/queue-actions.service';

const track = (id: string): Track => ({
  id, path: `/music/${id}.flac`, fileName: `${id}.flac`, title: id,
  artist: null, albumArtist: null, album: null, genre: null, year: null,
  trackNumber: null, discNumber: null, duration: 180, codec: 'FLAC', bitrate: null,
  sampleRate: 44100, bitDepth: 16, channels: 2, artwork: null, fileSize: null,
  lastModified: null, isAvailable: true,
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
  const gateway = { getSettings: async () => ({}), saveSettings: vi.fn(async (value: any) => value) };
  const injector = Injector.create({ providers: [{ provide: PLAYBACK_ENGINE, useValue: engine }, { provide: SETTINGS_GATEWAY, useValue: gateway }] });
  const player = runInInjectionContext(injector, () => new PlayerService());
  const actions = runInInjectionContext(Injector.create({ providers: [{ provide: PlayerService, useValue: player }], parent: injector }), () => new QueueActionsService());
  player.queue.set(['a', 'b', 'c', 'd'].map((id, i) => ({ id: `e${i}`, track: track(id), originalIndex: i })));
  player.currentIndex.set(2);
  return { player, actions, engine };
}

const ids = (player: PlayerService) => player.queue().map((entry) => entry.track.id);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('queue remove with undo', () => {
  it('undo puts an earlier entry back in place, keeps the current track and never counts the removal', () => {
    const { player, actions, engine } = setup();
    const kept = vi.fn();
    actions.removeWithUndo(player.queue()[0], kept);
    expect(ids(player)).toEqual(['b', 'c', 'd']);
    expect(player.currentIndex()).toBe(1);

    actions.notice()!.action!.run();
    expect(ids(player)).toEqual(['a', 'b', 'c', 'd']);
    expect(player.currentIndex()).toBe(2);
    expect(engine.dispose).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(kept).not.toHaveBeenCalled();
  });

  it('counts the removal once when the undo window ends or another notice replaces it', () => {
    const { player, actions } = setup();
    const first = vi.fn();
    const second = vi.fn();
    actions.removeWithUndo(player.queue()[3], first);
    actions.removeWithUndo(player.queue()[0], second);
    expect(first).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(6000);
    expect(second).toHaveBeenCalledOnce();
    expect(ids(player)).toEqual(['b', 'c']);
  });
});
