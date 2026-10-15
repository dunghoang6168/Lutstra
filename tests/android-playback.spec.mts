import '@angular/compiler';
import { NgZone } from '@angular/core';
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
    prepareNext: vi.fn(async () => undefined),
    cancelPreparedNext: vi.fn(async () => undefined),
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
});
