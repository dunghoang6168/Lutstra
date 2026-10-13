import '@angular/compiler';
import { describe, expect, it, vi } from 'vitest';
import { Injector, runInInjectionContext } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';
import { PLAYBACK_ENGINE, SETTINGS_GATEWAY } from '../src/app/core/contracts';
import type { Track } from '../src/app/core/models';
import { PlayerService } from '../src/app/core/player/player.service';

const track = (id: string): Track => ({
  id, path: `/music/${id}.flac`, fileName: `${id}.flac`, title: id,
  artist: null, albumArtist: null, album: null, genre: null, year: null,
  trackNumber: null, discNumber: null, duration: 180, codec: 'FLAC', bitrate: null,
  sampleRate: 44100, bitDepth: 16, channels: 2, artwork: null, fileSize: null,
  lastModified: null, isAvailable: true,
});

function player() {
  const engine: any = {
    stateChange$: new BehaviorSubject<any>({ state: 'idle', track: null }), timeUpdate$: new Subject(), volumeChange$: new Subject(),
    outputInterrupted$: new Subject(), subscribeDeviceChanges: () => () => undefined,
    setBackend: vi.fn(async () => undefined), getBackend: () => 'chromium', setOutputMode: vi.fn(async () => undefined),
    setOutputFallbackEnabled: vi.fn(), setVolume: vi.fn(), setMute: vi.fn(), cancelPreparedNext: vi.fn(),
    prepareNext: vi.fn(async () => false), listOutputDevices: async () => [], getAudioPathStatus: async () => null,
    selectOutputDevice: vi.fn(async () => undefined), pause: vi.fn(), play: vi.fn(), dispose: vi.fn(), load: vi.fn(async () => undefined),
  };
  const gateway = { getSettings: async () => ({}), saveSettings: vi.fn(async (value: any) => value) };
  const injector = Injector.create({ providers: [{ provide: PLAYBACK_ENGINE, useValue: engine }, { provide: SETTINGS_GATEWAY, useValue: gateway }] });
  const service = runInInjectionContext(injector, () => new PlayerService());
  service.queue.set([track('a'), track('b')].map((t, i) => ({ id: `e${i}`, track: t, originalIndex: i })));
  service.currentIndex.set(1);
  return service;
}

describe('queue end handler', () => {
  it('lets the handler choose what follows the last entry instead of wrapping on repeat all', async () => {
    const service = player();
    service.setRepeatMode('all');
    const handler = vi.fn();
    service.setQueueEndHandler(handler);
    await service.next();
    expect(handler).toHaveBeenCalledOnce();
    expect(service.currentIndex()).toBe(1);
    service.ngOnDestroy();
  });

  it('keeps the normal wrap once the handler is cleared', async () => {
    const service = player();
    service.setRepeatMode('all');
    service.setQueueEndHandler(vi.fn());
    service.setQueueEndHandler(null);
    await service.next();
    expect(service.currentIndex()).toBe(0);
    service.ngOnDestroy();
  });
});
