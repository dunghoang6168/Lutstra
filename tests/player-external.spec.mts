import '@angular/compiler';
import { describe, expect, it, vi } from 'vitest';
import { Injector, runInInjectionContext } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';
import { PLAYBACK_ENGINE, SETTINGS_GATEWAY } from '../src/app/core/contracts';
import type { Track } from '../src/app/core/models';
import { ExternalSource, PlayerService } from '../src/app/core/player/player.service';

const track = (id: string): Track => ({
  id, path: `/music/${id}.flac`, fileName: `${id}.flac`, title: id,
  artist: null, albumArtist: null, album: null, genre: null, year: null,
  trackNumber: null, discNumber: null, duration: 180, codec: 'FLAC', bitrate: null,
  sampleRate: 44100, bitDepth: 16, channels: 2, artwork: null, fileSize: null,
  lastModified: null, isAvailable: true,
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(queueIds = ['a', 'b'], currentIndex = 1) {
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
  player.queue.set(queueIds.map((id, i) => ({ id: `e${i}`, track: track(id), originalIndex: i })));
  player.currentIndex.set(currentIndex);
  if (currentIndex >= 0) player.currentTrack.set(track(queueIds[currentIndex]));
  return { player, engine };
}

/** A roulette-like source over a fixed list: `next` walks forward, `previous` back. */
function source(ids: string[]): ExternalSource & { position: number } {
  return {
    position: 0,
    next() { return this.position + 1 < ids.length ? track(ids[++this.position]) : null; },
    peek() { return this.position + 1 < ids.length ? track(ids[this.position + 1]) : null; },
    previous() { return this.position > 0 ? track(ids[--this.position]) : null; },
  };
}

const loadedIds = (engine: any) => engine.load.mock.calls.map(([t]: [Track]) => t.id);

describe('external source playback', () => {
  it('parks the queue at its entry and position, and resumes there', async () => {
    const { player, engine } = setup();
    player.currentTime.set(60);
    await player.playExternal(source(['x', 'y']), track('x'));

    expect(player.currentTrack()?.id).toBe('x');
    expect(player.currentIndex()).toBe(1);
    expect(player.queue().map((entry) => entry.track.id)).toEqual(['a', 'b']);
    expect(player.modesLocked()).toBe(true);

    await player.backToQueue();
    expect(player.externalSource()).toBeNull();
    expect(loadedIds(engine)).toEqual(['x', 'b']);
    expect(engine.seek).toHaveBeenLastCalledWith(60);
    expect(player.modesLocked()).toBe(false);
    player.ngOnDestroy();
  });

  it('keeps the first resume point across the source picks', async () => {
    const { player, engine } = setup();
    player.currentTime.set(42);
    const roulette = source(['x', 'y']);
    await player.playExternal(roulette, track('x'));
    player.currentTime.set(150);
    await player.next();
    expect(player.currentTrack()?.id).toBe('y');
    await player.backToQueue();
    expect(engine.seek).toHaveBeenLastCalledWith(42);
    player.ngOnDestroy();
  });

  it('sends Add to queue and Play next to the parked queue without interrupting', async () => {
    const { player, engine } = setup();
    await player.playExternal(source(['x']), track('x'));
    player.addToQueue([track('c')]);
    player.playNext([track('d')]);

    expect(loadedIds(engine)).toEqual(['x']);
    expect(player.currentTrack()?.id).toBe('x');
    expect(player.queue().map((entry) => entry.track.id)).toEqual(['a', 'b', 'd', 'c']);
    expect(player.currentIndex()).toBe(1);
    player.ngOnDestroy();
  });

  it('parks a queue started during the external source at its first entry, from the start', async () => {
    const { player, engine } = setup([], -1);
    await player.playExternal(source(['x']), track('x'));
    player.addToQueue([track('c'), track('d')]);
    expect(loadedIds(engine)).toEqual(['x']);

    await player.backToQueue();
    expect(loadedIds(engine)).toEqual(['x', 'c']);
    expect(engine.seek).not.toHaveBeenCalled();
    player.ngOnDestroy();
  });

  it('pauses when the source has nothing next', async () => {
    const { player, engine } = setup();
    await player.playExternal(source(['x']), track('x'));
    player.playbackState.set('playing');
    await player.next();
    expect(engine.pause).toHaveBeenCalled();
    expect(player.currentTrack()?.id).toBe('x');
    player.ngOnDestroy();
  });

  it('walks back through the source on Previous, and restarts after 3 seconds', async () => {
    const { player, engine } = setup();
    const roulette = source(['x', 'y']);
    await player.playExternal(roulette, track('x'));
    await player.next();
    player.currentTime.set(10);
    await player.previous();
    expect(engine.seek).toHaveBeenLastCalledWith(0);
    expect(player.currentTrack()?.id).toBe('y');

    player.currentTime.set(1);
    await player.previous();
    expect(player.currentTrack()?.id).toBe('x');
    player.ngOnDestroy();
  });

  it('ignores repeat one and moves on when an external track ends', async () => {
    const { player } = setup();
    player.setRepeatMode('one');
    await player.playExternal(source(['x', 'y']), track('x'));
    (player as any).engine.stateChange$.next({ state: 'ended', track: null });
    await flush();
    expect(player.currentTrack()?.id).toBe('y');
    expect(player.repeatMode()).toBe('one');
    player.ngOnDestroy();
  });

  it('ends the external source when the library plays something', async () => {
    const { player, engine } = setup();
    await player.playExternal(source(['x']), track('x'));
    await player.playCollection([track('z')]);
    expect(player.externalSource()).toBeNull();
    expect(player.queue().map((entry) => entry.track.id)).toEqual(['z']);
    expect(loadedIds(engine)).toEqual(['x', 'z']);
    player.ngOnDestroy();
  });

  it('ends the external source when a queue entry is picked', async () => {
    const { player, engine } = setup();
    await player.playExternal(source(['x']), track('x'));
    await player.jumpToQueueIndex(0);
    expect(player.externalSource()).toBeNull();
    expect(loadedIds(engine)).toEqual(['x', 'a']);
    player.ngOnDestroy();
  });

  it('clears only the queue while the external track plays, then stops on Back to queue', async () => {
    const { player, engine } = setup();
    await player.playExternal(source(['x']), track('x'));
    player.clearQueue();
    expect(engine.dispose).not.toHaveBeenCalled();
    expect(player.currentTrack()?.id).toBe('x');

    await player.backToQueue();
    expect(engine.dispose).toHaveBeenCalled();
    expect(player.externalSource()).toBeNull();
    expect(player.currentTrack()).toBeNull();
    player.ngOnDestroy();
  });

  it('moves the parked entry without loading when it is removed, resuming from the start', async () => {
    const { player, engine } = setup(['a', 'b', 'c']);
    player.currentTime.set(30);
    await player.playExternal(source(['x']), track('x'));
    player.removeFromQueue('e1');
    expect(loadedIds(engine)).toEqual(['x']);
    expect(player.currentIndex()).toBe(1);

    await player.backToQueue();
    expect(loadedIds(engine)).toEqual(['x', 'c']);
    expect(engine.seek).not.toHaveBeenCalled();
    player.ngOnDestroy();
  });

  it('skips a failing external track to the source next pick', async () => {
    const { player, engine } = setup();
    engine.load.mockImplementationOnce(async () => { throw new Error('[MEDIA_DECODE] bad file'); });
    await player.playExternal(source(['x', 'y']), track('x'));
    expect(player.currentTrack()?.id).toBe('y');
    expect(player.currentIndex()).toBe(1);
    player.ngOnDestroy();
  });

  it('follows the peeked track through a gapless transition', async () => {
    const { player, engine } = setup();
    engine.prepareNext.mockImplementation(async () => true);
    await player.playExternal(source(['x', 'y']), track('x'));
    player.playbackState.set('playing');
    engine.stateChange$.next({ state: 'playing', track: null });
    await flush();
    engine.stateChange$.next({ state: 'ended', track: null });
    await flush();
    expect(engine.transitionTo).toHaveBeenCalledWith(expect.objectContaining({ id: 'y' }), 0);
    expect(player.currentTrack()?.id).toBe('y');
    player.ngOnDestroy();
  });
});
