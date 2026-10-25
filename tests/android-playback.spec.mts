import '@angular/compiler';
import { Injector, NgZone, runInInjectionContext } from '@angular/core';
import { PLAYBACK_ENGINE, SETTINGS_GATEWAY } from '../src/app/core/contracts';
import { PlayerService } from '../src/app/core/player/player.service';
import { describe, expect, it, vi } from 'vitest';
import { AndroidPlaybackEngine, NativePlayback, NativePlaybackState, stateFrom } from '../src/app/core/android/android-playback.engine';
import { PlaybackStateEvent, Track } from '../src/app/core/models';

const native = (changes: Partial<NativePlaybackState> = {}): NativePlaybackState => ({
  playing: false, playWhenReady: false, playbackState: 3, positionMs: 0, durationMs: 1000, mediaId: null, ...changes,
});

const track = (id: string): Track => ({
  id, path: `content://tree/${id}`, fileName: `${id}.flac`, title: id, artist: null, albumArtist: null, album: null,
  genre: null, year: null, trackNumber: null, discNumber: null, duration: 1, codec: 'FLAC', bitrate: null,
  sampleRate: null, bitDepth: null, channels: null, artwork: null, fileSize: null, lastModified: null, isAvailable: true,
});

function fakeNative() {
  const handlers = new Map<string, (event: never) => void>();
  const plugin = {
    load: vi.fn(async () => native()),
    prepareNext: vi.fn(async () => ({ applied: true })),
    cancelPreparedNext: vi.fn(async () => undefined),
    setRepeatOne: vi.fn(async () => undefined),
    play: vi.fn(async () => native({ playing: true, playWhenReady: true })),
    pause: vi.fn(async () => native()),
    next: vi.fn(async () => native({ playing: true, playWhenReady: true })),
    seekTo: vi.fn(async () => native()),
    setVolume: vi.fn(async () => undefined),
    getState: vi.fn(async () => native()),
    addListener: vi.fn(async (event: string, handler: (event: never) => void) => {
      handlers.set(event, handler);
      return { remove: async () => undefined };
    }),
  };
  const emit = (event: string, payload: unknown) => handlers.get(event)!(payload as never);
  return { plugin: plugin as unknown as NativePlayback & typeof plugin, emit };
}

const zone = { run: (fn: () => unknown) => fn() } as unknown as NgZone;

describe('Android Media3 playback engine', () => {
  it('maps Media3 player states', () => {
    expect(stateFrom(native({ playbackState: 4 }))).toBe('ended');
    expect(stateFrom(native({ playing: true }))).toBe('playing');
    expect(stateFrom(native({ playbackState: 2, playWhenReady: true }))).toBe('buffering');
    expect(stateFrom(native())).toBe('paused');
  });

  it('follows Media3 into the prepared track and back, from playback or remote controls', async () => {
    const { plugin, emit } = fakeNative();
    const engine = new AndroidPlaybackEngine(zone, plugin);
    const advanced: Track[] = [];
    engine.trackAutoAdvanced$.subscribe((next) => advanced.push(next));

    await engine.load(track('a'));
    await engine.play();
    expect(await engine.prepareNext(track('b'))).toBe(true);
    emit('advanced', { mediaId: 'b', auto: true });
    emit('advanced', { mediaId: 'b', auto: false });
    emit('advanced', { mediaId: 'a', auto: false });
    emit('advanced', { mediaId: 'unknown', auto: false });
    expect(advanced.map((item) => item.id)).toEqual(['b', 'a']);
    engine.dispose();
  });

  it('keeps a seek on the timeline until Media3 reports it', async () => {
    const { plugin, emit } = fakeNative();
    const engine = new AndroidPlaybackEngine(zone, plugin);
    const times: number[] = [];
    engine.timeUpdate$.subscribe((event) => times.push(event.currentTime));
    await engine.load(track('a'));
    engine.seek(60);
    emit('state', native({ positionMs: 10_000, durationMs: 120_000 }));
    emit('state', native({ positionMs: 60_200, durationMs: 120_000 }));
    expect(times.slice(-2)).toEqual([60, 60.2]);
    engine.dispose();
  });

  it('drops a preparation that a newer load superseded', async () => {
    const { plugin } = fakeNative();
    const engine = new AndroidPlaybackEngine(zone, plugin);
    await engine.load(track('a'));
    const preparing = engine.prepareNext(track('b'));
    await engine.load(track('c'));
    expect(await preparing).toBe(false);
    engine.dispose();
  });

  it('answers a crossfade with the gapless continuation at the natural end', async () => {
    const { plugin, emit } = fakeNative();
    const engine = new AndroidPlaybackEngine(zone, plugin);
    const advanced: Track[] = [];
    engine.trackAutoAdvanced$.subscribe((next) => advanced.push(next));
    await engine.load(track('a'));
    await engine.prepareNext(track('b'));
    const fading = engine.transitionTo(track('b'), 4);
    await Promise.resolve();
    emit('advanced', { mediaId: 'b', auto: true });
    expect(await fading).toBe(true);
    expect(advanced).toEqual([]);
    expect(plugin.next).not.toHaveBeenCalled();

    await engine.load(track('a'));
    await engine.prepareNext(track('b'));
    const superseded = engine.transitionTo(track('b'), 4);
    await Promise.resolve();
    await engine.load(track('c'));
    expect(await superseded).toBe(false);
    expect(await engine.transitionTo(track('b'), 0)).toBe(true);
    expect(plugin.next).toHaveBeenCalledTimes(1);
    engine.dispose();
  });

  it('turns a Media3 error into a playback error for the current track', async () => {
    const { plugin, emit } = fakeNative();
    const engine = new AndroidPlaybackEngine(zone, plugin);
    const events: PlaybackStateEvent[] = [];
    engine.stateChange$.subscribe((event) => events.push(event));
    await engine.load(track('a'));
    emit('error', { code: 'ERROR_CODE_IO_FILE_NOT_FOUND', message: 'gone' });
    expect(events.at(-1)).toMatchObject({ state: 'error', error: { code: 'FILE_UNAVAILABLE', trackId: 'a' } });
    engine.dispose();
  });

  it('does not apply a preparation once Media3 has moved past the track it was meant for', async () => {
    const { plugin } = fakeNative();
    plugin.prepareNext.mockImplementationOnce(async () => ({ applied: false }));
    const engine = new AndroidPlaybackEngine(zone, plugin);
    await engine.load(track('a'));
    expect(await engine.prepareNext(track('b'), [track('c')])).toBe(false);
    expect(plugin.prepareNext).toHaveBeenCalledWith({ afterId: 'a', items: [expect.objectContaining({ id: 'b' }), expect.objectContaining({ id: 'c' })] });
    engine.dispose();
  });
});

/** Media3 with a real item list: a call is applied only while `afterId` is still current, as in PlaybackPlugin. */
function media3() {
  const handlers = new Map<string, (event: never) => void>();
  const held: [string, unknown][] = [];
  const m = { items: [] as string[], index: 0, asleep: false };
  const isCurrent = (id: string | null) => m.items[m.index] === id;
  const emit = (event: string, payload: unknown) => {
    if (m.asleep) held.push([event, payload]); else handlers.get(event)?.(payload as never);
  };
  const playing = () => native({ playing: true, playWhenReady: true, mediaId: m.items[m.index] ?? null });
  const plugin = {
    load: vi.fn(async (item: { id: string }) => { m.items = [item.id]; m.index = 0; return native({ mediaId: item.id }); }),
    prepareNext: vi.fn(async ({ afterId, items }: { afterId: string | null; items: { id: string }[] }) => {
      if (!isCurrent(afterId)) return { applied: false };
      m.items = [...m.items.slice(0, m.index + 1), ...items.map((item) => item.id)];
      return { applied: true };
    }),
    cancelPreparedNext: vi.fn(async ({ afterId }: { afterId: string | null }) => {
      if (isCurrent(afterId)) m.items = m.items.slice(0, m.index + 1);
    }),
    setRepeatOne: vi.fn(async () => undefined),
    play: vi.fn(async () => playing()),
    pause: vi.fn(async () => native()),
    next: vi.fn(async () => { m.index++; return playing(); }),
    seekTo: vi.fn(async () => native()),
    setVolume: vi.fn(async () => undefined),
    getState: vi.fn(async () => playing()),
    addListener: vi.fn(async (event: string, handler: (event: never) => void) => {
      handlers.set(event, handler);
      return { remove: async () => undefined };
    }),
  };
  /** The current track ends and Media3 moves on by itself; false at the end of its list. */
  const finishTrack = () => {
    if (m.index + 1 >= m.items.length) return false;
    m.index++;
    emit('advanced', { mediaId: m.items[m.index], auto: true });
    return true;
  };
  const wake = () => { m.asleep = false; for (const [event, payload] of held.splice(0)) emit(event, payload); };
  return { plugin: plugin as unknown as NativePlayback & typeof plugin, m, finishTrack, wake };
}

describe('Android queue with the screen off', () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  function setup() {
    const media = media3();
    const engine = new AndroidPlaybackEngine(zone, media.plugin);
    const gateway = { getSettings: async () => ({}), saveSettings: vi.fn(async (value: unknown) => value) };
    const injector = Injector.create({ providers: [{ provide: PLAYBACK_ENGINE, useValue: engine }, { provide: SETTINGS_GATEWAY, useValue: gateway }] });
    const player = runInInjectionContext(injector, () => new PlayerService());
    return { ...media, engine, player };
  }

  it('hands Media3 the whole rest of the queue, so it plays on while the web sleeps', async () => {
    const { player, m, finishTrack, wake } = setup();
    await player.playCollection(['a', 'b', 'c', 'd', 'e'].map(track));
    await flush();
    expect(m.items).toEqual(['a', 'b', 'c', 'd', 'e']);

    // Screen off: the web hears nothing while Media3 goes through three tracks.
    m.asleep = true;
    expect(finishTrack() && finishTrack() && finishTrack()).toBe(true);
    wake();
    await flush();
    expect(player.currentTrack()?.id).toBe('d');
    expect(player.currentIndex()).toBe(3);
    // The catch-up's stale preparations changed nothing.
    expect(m.items).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(m.index).toBe(3);

    // A queue edit after the next track still reaches Media3.
    player.addToQueue([track('f')]);
    await flush();
    expect(m.items.slice(m.index)).toEqual(['d', 'e', 'f']);
    player.ngOnDestroy();
  });

  it('loops Repeat one, and Repeat all over one track, in Media3 itself', async () => {
    const { player, plugin } = setup();
    await player.playCollection(['a', 'b'].map(track));
    await flush();
    player.setRepeatMode('one');
    expect(plugin.setRepeatOne).toHaveBeenLastCalledWith({ on: true });
    player.setRepeatMode('all');
    expect(plugin.setRepeatOne).toHaveBeenLastCalledWith({ on: false });
    await player.playCollection([track('solo')]);
    await flush();
    expect(plugin.setRepeatOne).toHaveBeenLastCalledWith({ on: true });
    player.setRepeatMode('off');
    expect(plugin.setRepeatOne).toHaveBeenLastCalledWith({ on: false });
    player.ngOnDestroy();
  });

  it('hands Media3 Repeat all as the queue looped over and over, a short run first and the rest once settled', async () => {
    vi.useFakeTimers();
    const { player, m } = setup();
    player.setRepeatMode('all');
    await player.playCollection(['a', 'b', 'c'].map(track), 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(m.items.slice(0, 7)).toEqual(['b', 'c', 'a', 'b', 'c', 'a', 'b']);
    expect(m.items.length).toBe(22);
    await vi.advanceTimersByTimeAsync(3000);
    expect(m.items.length).toBe(302);
    expect(m.items.slice(0, 22)).toEqual(['b', 'c', 'a', 'b', 'c', 'a', 'b', 'c', 'a', 'b', 'c', 'a', 'b', 'c', 'a', 'b', 'c', 'a', 'b', 'c', 'a', 'b']);
    player.ngOnDestroy();
    vi.useRealTimers();
  });

  it("plays on into Autoplay's reserve while the web sleeps, and queues what it played", async () => {
    const { player, m, finishTrack, wake } = setup();
    await player.playCollection(['a', 'b'].map(track));
    player.setAutoplayReserve(['x', 'y', 'z'].map(track));
    await flush();
    expect(m.items).toEqual(['a', 'b', 'x', 'y', 'z']);

    m.asleep = true;
    expect(finishTrack() && finishTrack() && finishTrack()).toBe(true);
    wake();
    await flush();
    expect(player.queue().map((entry) => entry.track.id)).toEqual(['a', 'b', 'x', 'y']);
    expect(player.queue().slice(2).every((entry) => entry.suggested)).toBe(true);
    expect(player.currentIndex()).toBe(3);
    expect(m.items.slice(m.index)).toEqual(['y', 'z']);
    player.ngOnDestroy();
  });
});
