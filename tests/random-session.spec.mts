import '@angular/compiler';
import { describe, expect, it, vi } from 'vitest';
import { Injector } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';
import { PLAYBACK_ENGINE, SETTINGS_GATEWAY } from '../src/app/core/contracts';
import type { Track } from '../src/app/core/models';
import { PlayerService } from '../src/app/core/player/player.service';
import { QueueActionsService } from '../src/app/core/player/queue-actions.service';
import { RandomSessionService } from '../src/app/features/random-folder/random-session.service';

// The round is driven through the player; the "round over" effect is checked in Electron.
vi.mock('@angular/core', async (importOriginal) => ({
  ...await importOriginal<typeof import('@angular/core')>(),
  effect: vi.fn(() => ({ destroy: vi.fn() })),
}));

const track = (id: string): Track => ({
  id, path: `/music/${id}.flac`, fileName: `${id}.flac`, title: id,
  artist: null, albumArtist: null, album: null, genre: null, year: null,
  trackNumber: null, discNumber: null, duration: 180, codec: 'FLAC', bitrate: null,
  sampleRate: 44100, bitDepth: 16, channels: 2, artwork: null, fileSize: null,
  lastModified: null, isAvailable: true,
});

function setup(pool = ['x', 'y', 'z']) {
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
  const injector = Injector.create({ providers: [
    { provide: PLAYBACK_ENGINE, useValue: engine }, { provide: SETTINGS_GATEWAY, useValue: gateway },
    ...[PlayerService, QueueActionsService, RandomSessionService].map((type) => ({ provide: type, useFactory: () => new type(), deps: [] })),
  ] });
  const player = injector.get(PlayerService);
  const session = injector.get(RandomSessionService);
  const queueActions = injector.get(QueueActionsService);
  session.setOption('rollEveryTrack', false);
  session.setOption('noRepeats', true);
  session.setOption('infinite', false);
  player.queue.set([track('a'), track('b')].map((t, i) => ({ id: `e${i}`, track: t, originalIndex: i })));
  player.currentIndex.set(1);
  player.currentTrack.set(track('b'));
  const roll = async () => {
    expect(session.start(pool.map(track), 'Source')).toBe(true);
    await session.spinDone();
  };
  return { player, session, engine, queueActions, roll };
}

const current = (player: PlayerService) => player.currentTrack()?.id;

describe('roulette round as an external source', () => {
  it('plays the first pick without touching the queue', async () => {
    const { player, session, roll } = setup();
    await roll();
    expect(session.active()).toBe(true);
    expect(['x', 'y', 'z']).toContain(current(player));
    expect(player.queue().map((entry) => entry.track.id)).toEqual(['a', 'b']);
    expect(player.currentIndex()).toBe(1);
    player.ngOnDestroy();
  });

  it('walks back and forth through the round history before a new pick', async () => {
    const { player, roll } = setup();
    await roll();
    const first = current(player);
    await player.next();
    const second = current(player);
    expect(second).not.toBe(first);

    await player.previous();
    expect(current(player)).toBe(first);
    await player.previous();
    expect(current(player)).toBe(first);
    await player.next();
    expect(current(player)).toBe(second);
    await player.next();
    expect([first, second]).not.toContain(current(player));
    player.ngOnDestroy();
  });

  it('stops with a notice once every track was played', async () => {
    const { player, session, roll } = setup(['x', 'y']);
    await roll();
    await player.next();
    const last = current(player);
    player.playbackState.set('playing');
    await player.next();
    expect(current(player)).toBe(last);
    expect(session.notice()).toContain('Played all 2 tracks');
    expect(session.active()).toBe(true);
    player.ngOnDestroy();
  });

  it('keeps playing while tracks are added to the queue', async () => {
    const { player, session, queueActions, roll } = setup();
    await roll();
    const playing = current(player);
    queueActions.add([track('c')]);
    player.playNext([track('d')]);
    expect(session.active()).toBe(true);
    expect(current(player)).toBe(playing);
    expect(player.queue().map((entry) => entry.track.id)).toEqual(['a', 'b', 'd', 'c']);
    queueActions.clear();
    player.ngOnDestroy();
  });

  it('picks ahead for gapless playback and plays that pick next', async () => {
    const { player, session, roll } = setup();
    await roll();
    const peeked = (session as any).source.peek() as Track;
    expect((session as any).source.peek()).toBe(peeked);
    await player.next();
    expect(current(player)).toBe(peeked.id);
    player.ngOnDestroy();
  });

  it('rolls the reel on the page before the next track, then plays its pick', async () => {
    (globalThis as any).document = { hidden: false };
    try {
      const { player, session, engine, roll } = setup();
      await roll();
      session.setOption('rollEveryTrack', true);
      session.pageOpen.set(true);
      const playing = current(player);
      expect((session as any).source.peek()).toBeNull();

      await player.next();
      const spin = session.spin()!;
      expect(spin.settled).toBe(false);
      expect(current(player)).toBe(playing);
      const loads = engine.load.mock.calls.length;

      await session.spinDone();
      expect(current(player)).toBe(spin.pick.id);
      expect(engine.load.mock.calls.length).toBe(loads + 1);
      player.ngOnDestroy();
    } finally {
      delete (globalThis as any).document;
    }
  });

  it('resumes the parked queue entry on Back to queue', async () => {
    const { player, session, engine, roll } = setup();
    player.currentTime.set(75);
    await roll();
    await player.backToQueue();
    expect(session.active()).toBe(false);
    expect(current(player)).toBe('b');
    expect(engine.seek).toHaveBeenLastCalledWith(75);
    player.ngOnDestroy();
  });
});
