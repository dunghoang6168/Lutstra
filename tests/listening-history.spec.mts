import '@angular/compiler';
import { describe, expect, it, vi } from 'vitest';
import { Injector, runInInjectionContext } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';
import { closedListen, endWindowFor, ListenObservation, ListenTracker, parseOpenListen } from '../src/app/core/history/listen-tracker';
import { HistoryEntry, PlayEvent, shownInHistory, Track } from '../src/app/core/models';
import { MockListeningHistoryGateway } from '../src/app/core/mock/mock-listening-history.gateway';
import { validHistoryPageRequest, validPlayEvent } from '../electron/ipc/ipc-validation';
import { DatabaseService } from '../electron/services/database.service';
import { historyDays, HistoryRow, mergeHistory } from '../src/app/features/history/history.component';
import { PLAYBACK_ENGINE, SETTINGS_GATEWAY } from '../src/app/core/contracts';
import { ExternalSource, PlayerService } from '../src/app/core/player/player.service';

const ID = (n: number) => `track-${String(n).padStart(64, '0')}`;

function observer() {
  const events: PlayEvent[] = [];
  const tracker = new ListenTracker((event) => events.push(event));
  let now = 1_000;
  const at = (key: string | null, time: number, options: Partial<ListenObservation> = {}, cause: 'next' | 'previous' | 'user' | null = null) =>
    tracker.observe({ key, trackId: key, time, duration: 200, playing: true, source: 'queue', endWindow: 3, ...options }, cause, now += 250);
  /** Plays `key` from `from` to `to` in 0.5 s steps. */
  const play = (key: string, from: number, to: number, options: Partial<ListenObservation> = {}) => {
    for (let time = from; time <= to; time += 0.5) at(key, time, options);
  };
  return { events, tracker, at, play };
}

describe('listen tracker', () => {
  it('records a track played to the end as ended and the next one as an automatic start', () => {
    const { events, play, at } = observer();
    play('a', 0, 198);
    at('b', 0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ trackId: 'a', endReason: 'ended', startedBy: 'resume', source: 'queue' });
    expect(events[0].playedSeconds).toBeCloseTo(198, 0);
    play('b', 0.5, 40);
    at('c', 0, {}, 'next');
    expect(events[1]).toMatchObject({ trackId: 'b', endReason: 'skip_next', startedBy: 'auto' });
  });

  it('counts a crossfade that starts the next track early as played through', () => {
    const { events, play, at } = observer();
    const endWindow = endWindowFor(true, 6);
    expect(endWindow).toBe(7);
    play('a', 0, 194, { endWindow });
    at('b', 0, { endWindow });
    expect(events[0].endReason).toBe('ended');
  });

  it('tells skips, previous and picks apart and keeps the cause as the next start', () => {
    const { events, play, at } = observer();
    play('a', 0, 20);
    at('b', 0, {}, 'previous');
    play('b', 0.5, 20);
    at('c', 0, {}, 'user');
    play('c', 0.5, 20);
    at(null, 0);
    expect(events.map((event) => [event.endReason, event.startedBy])).toEqual([
      ['skip_previous', 'resume'], ['picked_other', 'previous'], ['other', 'user'],
    ]);
  });

  it('drops listens under a second and keeps seeks out of the played time', () => {
    const { events, play, at } = observer();
    at('a', 0);
    at('a', 0.5);
    at('b', 0, {}, 'next');
    expect(events).toHaveLength(0);
    play('b', 0.5, 10);
    at('b', 120);
    play('b', 120.5, 130);
    at('c', 0, {}, 'next');
    expect(events[0].playedSeconds).toBeCloseTo(20, 0);
    expect(events[0].seekForwardSeconds).toBeCloseTo(110, 0);
    expect(events[0].endPosition).toBe(130);
  });

  it('splits Repeat One loops into separate listens', () => {
    const { events, play } = observer();
    play('a', 0, 199);
    play('a', 0, 10);
    expect(events).toHaveLength(1);
    expect(events[0].endReason).toBe('ended');
    expect(events[0].trackId).toBe('a');
  });

  it('does not count time that passes while paused', () => {
    const { events, at, play } = observer();
    play('a', 0, 10);
    at('a', 11, { playing: false });
    play('a', 11.5, 20);
    at('b', 0, {}, 'next');
    // 0→10 and 11→20 played; the step to 11 happened while paused.
    expect(events[0].playedSeconds).toBe(19);
  });

  it('restores an interrupted listen as app_closed', () => {
    const { tracker, play } = observer();
    play('a', 0, 30);
    const saved = parseOpenListen(JSON.stringify(tracker.current()));
    expect(saved).not.toBeNull();
    expect(closedListen(saved!, 'app_closed')).toMatchObject({ trackId: 'a', endReason: 'app_closed' });
    expect(parseOpenListen('{"key":"a"}')).toBeNull();
    expect(parseOpenListen('not json')).toBeNull();
  });
});

describe('listening history storage', () => {
  const event = (overrides: Partial<PlayEvent> = {}): PlayEvent => ({
    trackId: ID(1), startedAt: 1_700_000_000_000, playedSeconds: 120, endPosition: 120, duration: 200,
    seekForwardSeconds: 0, startedBy: 'auto', endReason: 'skip_next', source: 'queue', ...overrides,
  });

  it('shows every listen except roulette rolls, quick skips included', () => {
    expect(shownInHistory(event())).toBe(true);
    expect(shownInHistory(event({ playedSeconds: 2 }))).toBe(true);
    expect(shownInHistory(event({ source: 'roulette' }))).toBe(false);
  });

  it('validates listens and page requests from the renderer', () => {
    expect(validPlayEvent(event())).toEqual(event());
    expect(() => validPlayEvent(event({ trackId: 'nope' }))).toThrow();
    expect(() => validPlayEvent(event({ endReason: 'bored' as never }))).toThrow();
    expect(() => validPlayEvent(event({ playedSeconds: -1 }))).toThrow();
    expect(() => validPlayEvent({ ...event(), startedAt: 1.5 })).toThrow();
    expect(validHistoryPageRequest({ limit: 200 })).toEqual({ limit: 200 });
    expect(validHistoryPageRequest({ limit: 5, before: { startedAt: 10, id: 3 } })).toEqual({ limit: 5, before: { startedAt: 10, id: 3 } });
    expect(() => validHistoryPageRequest({ limit: 201 })).toThrow();
    expect(() => validHistoryPageRequest({ limit: 5, before: { startedAt: 'x', id: 3 } })).toThrow();
  });

  it('pages the database newest first and filters like the renderer', () => {
    const database = new DatabaseService(':memory:');
    try {
      for (let i = 0; i < 5; i++) database.recordPlayEvent(event({ trackId: ID(i), startedAt: 1_000 + i }));
      database.recordPlayEvent(event({ trackId: ID(9), startedAt: 2_000, source: 'roulette' }));
      database.recordPlayEvent(event({ trackId: ID(8), startedAt: 2_001, playedSeconds: 5 }));
      const first = database.listHistory({ limit: 3 });
      expect(first.map((entry) => entry.trackId)).toEqual([ID(8), ID(4), ID(3)]);
      const last = first.at(-1)!;
      const second = database.listHistory({ limit: 3, before: { startedAt: last.startedAt, id: last.id } });
      expect(second.map((entry) => entry.trackId)).toEqual([ID(2), ID(1), ID(0)]);
      database.clearHistory();
      expect(database.listHistory({ limit: 3 })).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('pages the in-memory gateway the same way', async () => {
    const gateway = new MockListeningHistoryGateway();
    for (let i = 0; i < 3; i++) await gateway.record(event({ trackId: ID(i), startedAt: 1_000 + i }));
    await gateway.record(event({ source: 'roulette', startedAt: 5_000 }));
    const first = await gateway.list({ limit: 2 });
    expect(first.map((entry) => entry.trackId)).toEqual([ID(2), ID(1)]);
    const second = await gateway.list({ limit: 2, before: { startedAt: first[1].startedAt, id: first[1].id } });
    expect(second.map((entry) => entry.trackId)).toEqual([ID(0)]);
  });
});

describe('History page helpers', () => {
  const track = { id: 'a' } as Track;
  const row = (id: string, startedAt: number): HistoryRow => ({ id, track, startedAt });

  it('groups by local day as Today, Yesterday, then the date', () => {
    const now = new Date(2026, 9, 16, 21, 0).getTime();
    const days = historyDays([
      row('1', new Date(2026, 9, 16, 20, 0).getTime()),
      row('2', new Date(2026, 9, 16, 8, 0).getTime()),
      row('3', new Date(2026, 9, 15, 23, 0).getTime()),
      row('4', new Date(2026, 9, 1, 12, 0).getTime()),
    ], now);
    expect(days.map((day) => [day.label, day.rows.length])).toEqual([
      ['Today', 2], ['Yesterday', 1], [new Date(2026, 9, 1).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }), 1],
    ]);
  });

  it('merges a refreshed page without duplicates', () => {
    const entry = (id: number, startedAt: number): HistoryEntry => ({ id, trackId: 'a', startedAt });
    expect(mergeHistory([entry(2, 20), entry(1, 10)], [entry(3, 30), entry(2, 20)]).map((item) => item.id)).toEqual([3, 2, 1]);
  });
});

describe('transport causes', () => {
  const track = (id: string): Track => ({
    id, path: `/music/${id}.flac`, fileName: `${id}.flac`, title: id, artist: null, albumArtist: null, album: null, genre: null,
    year: null, trackNumber: null, discNumber: null, duration: 180, codec: 'FLAC', bitrate: null, sampleRate: 44100, bitDepth: 16,
    channels: 2, artwork: null, fileSize: null, lastModified: null, isAvailable: true,
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
    player.queue.set(['a', 'b', 'c'].map((id, i) => ({ id: `e${i}`, track: track(id), originalIndex: i })));
    player.currentIndex.set(0);
    player.currentTrack.set(track('a'));
    return { player, engine };
  }

  it('marks user skips and picks, not automatic advances', async () => {
    const { player, engine } = setup();
    expect(player.lastTransition()).toBeNull();
    await player.next();
    expect(player.lastTransition()?.cause).toBe('next');
    await player.previous();
    expect(player.lastTransition()?.cause).toBe('previous');
    await player.jumpToQueueIndex(2);
    expect(player.lastTransition()?.cause).toBe('user');

    const before = player.lastTransition();
    player.currentIndex.set(0);
    engine.stateChange$.next({ state: 'ended', track: track('a') });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(player.lastTransition()).toBe(before);
  });

  it('keeps a skip inside an external source a skip', async () => {
    const { player } = setup();
    const source: ExternalSource = { next: () => track('y'), peek: () => track('y'), previous: () => null };
    await player.playExternal(source, track('x'));
    expect(player.lastTransition()?.cause).toBe('user');
    await player.next();
    expect(player.lastTransition()?.cause).toBe('next');
  });
});
