import '@angular/compiler';
import { describe, expect, it, vi } from 'vitest';
import { Injector, runInInjectionContext } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';
import { PlayEvent, QueueEntry, Track } from '../src/app/core/models';
import {
  addListen, artistKey, buildProfile, coldPrior, dupKey, emptyProfile, fatigue, signalOf, TrackFacts,
} from '../src/app/core/smart-shuffle/listener-profile';
import {
  breaksArtistRun, newSession, PlanEntry, planUpcoming, relatedness, sampleBeta, ScoreContext, suggestionSpacing, updateSession,
} from '../src/app/core/smart-shuffle/smart-shuffle';
import { validPlaybackSession } from '../electron/ipc/settings-validation';
import { PLAYBACK_ENGINE, SETTINGS_GATEWAY } from '../src/app/core/contracts';
import { PlayerService } from '../src/app/core/player/player.service';

/** mulberry32: deterministic draws for the sampled scores. */
function seeded(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY = 86_400_000;
const NOW = new Date(2026, 9, 16, 21, 0).getTime();

function fact(id: string, artist: string, region = 'VN', extra: Partial<TrackFacts> = {}): TrackFacts {
  return { id, dupKey: id + '|' + artist, artistKey: artist, region, genre: null, year: null, addedAt: null, inPlaylist: false, popularity: null, ...extra };
}

/** 5 artists × 6 tracks, artists a–c in VN, d–e in KOR. */
function library(): Map<string, TrackFacts> {
  const facts = new Map<string, TrackFacts>();
  for (const artist of ['a', 'b', 'c', 'd', 'e']) {
    for (let i = 0; i < 6; i++) facts.set(`${artist}${i}`, fact(`${artist}${i}`, artist, artist < 'd' ? 'VN' : 'KOR'));
  }
  return facts;
}

function listen(trackId: string, overrides: Partial<PlayEvent> = {}): PlayEvent {
  return {
    trackId, startedAt: NOW - DAY * 3, playedSeconds: 200, endPosition: 200, duration: 200, seekForwardSeconds: 0,
    startedBy: 'auto', endReason: 'ended', source: 'queue', ...overrides,
  };
}

function context(facts: Map<string, TrackFacts>, events: PlayEvent[] = [], seed = 7): ScoreContext {
  return { profile: buildProfile(events, facts, NOW), facts, now: NOW, bucket: 'evening', session: newSession(), random: seeded(seed) };
}

const user = (trackId: string, extra: Partial<PlanEntry> = {}): PlanEntry => ({ entryId: 'e-' + trackId, trackId, suggested: false, pinned: false, ...extra });

describe('listener profile', () => {
  it('reads likes and dislikes from listens', () => {
    expect(signalOf(listen('a'))).toEqual({ like: 1, dislike: 0 });
    expect(signalOf(listen('a', { startedBy: 'user' }))).toEqual({ like: 1.5, dislike: 0 });
    expect(signalOf(listen('a', { endReason: 'skip_next', playedSeconds: 10 }))).toEqual({ like: 0, dislike: 1 });
    expect(signalOf(listen('a', { endReason: 'skip_next', playedSeconds: 90 }))).toEqual({ like: 0, dislike: 0.3 });
    expect(signalOf(listen('a', { endReason: 'removed', playedSeconds: 0 }))).toEqual({ like: 0, dislike: 0.5 });
    expect(signalOf(listen('a', { seekForwardSeconds: 150 }))).toEqual({ like: 0.5, dislike: 0.3 });
    for (const endReason of ['app_closed', 'other', 'skip_previous'] as const) expect(signalOf(listen('a', { endReason, playedSeconds: 10 }))).toBeNull();
  });

  it('halves a listen every 60 days and spreads it to the artist and region', () => {
    const facts = library();
    const profile = buildProfile([listen('a0', { startedAt: NOW }), listen('a1', { startedAt: NOW - 60 * DAY })], facts, NOW);
    expect(profile.tracks.get('a0')!.like).toBeCloseTo(1);
    expect(profile.tracks.get('a1')!.like).toBeCloseTo(0.5);
    expect(profile.groups.get('artist:a')!.like).toBeCloseTo(1.5);
    expect(profile.groups.get('region:VN')!.like).toBeCloseTo(1.5);
  });

  it('rests a track for a day after it plays, then brings it back over a week', () => {
    const profile = emptyProfile(library());
    addListen(profile, listen('a0', { startedAt: NOW - 2 * 3_600_000 }), library(), NOW);
    expect(fatigue('a0', profile, NOW)).toBe(0);
    expect(fatigue('a0', profile, NOW + 4 * DAY)).toBeGreaterThan(0.3);
    expect(fatigue('a0', profile, NOW + 8 * DAY)).toBe(1);
    expect(fatigue('b0', profile, NOW)).toBe(1);
  });

  it('starts cold from what the library holds: big artists, new files and playlists', () => {
    const facts = library();
    facts.set('z0', fact('z0', 'z', 'JP'));
    facts.set('a9', fact('a9', 'a', 'VN', { inPlaylist: true, addedAt: NOW }));
    facts.set('a8', fact('a8', 'a', 'VN', { addedAt: NOW - 200 * DAY }));
    const profile = emptyProfile(facts);
    expect(coldPrior(facts.get('a0')!, profile)).toBeGreaterThan(coldPrior(facts.get('z0')!, profile));
    expect(coldPrior(facts.get('a9')!, profile)).toBeGreaterThan(coldPrior(facts.get('a8')!, profile));
  });

  it('keys artists by the first credit and spots remasters of the same song', () => {
    expect(artistKey(null, 'MCK feat. tlinh')).toBe('mck');
    expect(artistKey('Aimer', 'Aimer, Vaundy')).toBe('aimer');
    expect(dupKey('Chìm sâu (Remastered 2024)', null, 'MCK')).toBe(dupKey('Chìm sâu', 'MCK', 'MCK feat. Trung Trần'));
  });
});

describe('smart shuffle picks', () => {
  it('samples Beta around its mean', () => {
    const random = seeded(1);
    const draws = Array.from({ length: 4000 }, () => sampleBeta(6, 2, random));
    expect(draws.reduce((sum, value) => sum + value, 0) / draws.length).toBeCloseTo(0.75, 1);
    expect(draws.every((value) => value > 0 && value < 1)).toBe(true);
  });

  it('links tracks by artist, region, genre and era', () => {
    const facts = library();
    expect(relatedness(facts.get('a0'), facts.get('a1'))).toBe(1);
    expect(relatedness(facts.get('a0'), facts.get('b0'))).toBe(0.6);
    expect(relatedness(facts.get('a0'), facts.get('d0'))).toBe(0.15);
    expect(relatedness(fact('x', 'x', 'VN', { genre: 'Rap' }), fact('y', 'y', 'VN', { genre: 'rap' }))).toBeCloseTo(0.7);
  });

  it('never plays three tracks by one artist in a row', () => {
    const facts = library();
    expect(breaksArtistRun([facts.get('a0'), facts.get('a1')], facts.get('a2')!)).toBe(true);
    expect(breaksArtistRun([facts.get('b0'), facts.get('a1')], facts.get('a2')!)).toBe(false);
  });

  it('fills an empty queue with ten suggestions, none excluded or repeated, no artist three times running', () => {
    const facts = library();
    const plan = planUpcoming({ upcoming: [], recent: [], userRun: 0, every: 3, window: 10, refresh: false, reorder: false, exclude: new Set(['a0', 'b0']) }, context(facts));
    expect(plan).toHaveLength(10);
    expect(plan.every((item) => item.suggested && item.entryId === null)).toBe(true);
    expect(new Set(plan.map((item) => item.trackId)).size).toBe(10);
    expect(plan.some((item) => item.trackId === 'a0' || item.trackId === 'b0')).toBe(false);
    for (let i = 2; i < plan.length; i++) {
      const artists = [plan[i - 2], plan[i - 1], plan[i]].map((item) => facts.get(item.trackId)!.artistKey);
      expect(new Set(artists).size).toBeGreaterThan(1);
    }
  });

  it('puts one suggestion after every three of the user tracks inside the window only', () => {
    const facts = library();
    const upcoming = ['a1', 'b1', 'c1', 'd1', 'e1', 'a2', 'b2', 'c2', 'd2', 'e2', 'a3', 'b3'].map((id) => user(id));
    const plan = planUpcoming({ upcoming, recent: ['a0'], userRun: 1, every: 3, window: 10, refresh: false, reorder: false, exclude: new Set() }, context(facts));
    const marks = plan.map((item) => item.suggested ? 'S' : 'u').join('');
    // The current track counts as one of the run, so the first suggestion comes after two more.
    expect(marks).toBe('uuSuuuSuuuuuuu');
    expect(plan.filter((item) => !item.suggested).map((item) => item.trackId)).toEqual(upcoming.map((item) => item.trackId));
    expect(plan.filter((item) => item.suggested).every((item) => !upcoming.some((entry) => entry.trackId === item.trackId))).toBe(true);
  });

  it('keeps the prepared next track and drops the tentative suggestions on refresh', () => {
    const facts = library();
    const upcoming = [user('a1'), user('d5', { suggested: true }), user('b1'), user('c1'), user('e5', { suggested: true }), user('d1')];
    const plan = planUpcoming({ upcoming, recent: ['a0'], userRun: 0, every: 3, window: 10, refresh: true, reorder: false, exclude: new Set() }, context(facts));
    expect(plan[0].entryId).toBe('e-a1');
    expect(plan.some((item) => item.entryId === 'e-e5' || item.entryId === 'e-d5')).toBe(false);
    expect(plan.filter((item) => !item.suggested).map((item) => item.trackId)).toEqual(['a1', 'b1', 'c1', 'd1']);
  });

  it('keeps a suggestion the user dragged into place on refresh', () => {
    const upcoming = [user('a1'), user('b1'), user('d5', { suggested: true, pinned: true }), user('c1')];
    const plan = planUpcoming({ upcoming, recent: ['a0'], userRun: 0, every: 99, window: 4, refresh: true, reorder: false, exclude: new Set() }, context(library()));
    expect(plan.map((item) => item.entryId)).toEqual(['e-a1', 'e-b1', 'e-d5', 'e-c1']);
  });

  it('reorders the user tracks by taste but leaves pinned ones in their slots', () => {
    const facts = library();
    const liked = Array.from({ length: 8 }, (_, i) => listen('e3', { startedAt: NOW - (i + 2) * DAY, startedBy: 'user' }));
    const skipped = Array.from({ length: 8 }, (_, i) => listen('a3', { startedAt: NOW - (i + 2) * DAY, endReason: 'skip_next', playedSeconds: 5 }));
    const upcoming = [user('a3'), user('b2', { pinned: true }), user('c2'), user('e3')];
    const plan = planUpcoming({ upcoming, recent: [], userRun: 0, every: 99, window: 4, refresh: false, reorder: true, exclude: new Set() }, context(facts, [...liked, ...skipped]));
    const ids = plan.map((item) => item.trackId);
    expect(ids[1]).toBe('b2');
    expect(ids.indexOf('e3')).toBeLessThan(ids.indexOf('a3'));
    expect([...ids].sort()).toEqual(['a3', 'b2', 'c2', 'e3']);
  });

  it('leans towards what the listener plays through', () => {
    const facts = library();
    const events = [
      ...Array.from({ length: 12 }, (_, i) => listen(`d${i % 6}`, { startedAt: NOW - (i + 2) * DAY })),
      ...Array.from({ length: 12 }, (_, i) => listen(`a${i % 6}`, { startedAt: NOW - (i + 2) * DAY, endReason: 'skip_next', playedSeconds: 5 })),
    ];
    let kor = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const plan = planUpcoming({ upcoming: [], recent: [], userRun: 0, every: 3, window: 1, refresh: false, reorder: false, exclude: new Set() }, context(facts, events, seed));
      if (facts.get(plan[0].trackId)!.region === 'KOR') kor++;
    }
    expect(kor).toBeGreaterThanOrEqual(14);
  });

  it('spaces suggestions out when they get skipped and closer when they play through', () => {
    const suggested = (endReason: PlayEvent['endReason'], playedSeconds: number) => listen('a0', { source: 'smart-shuffle', endReason, playedSeconds });
    expect(suggestionSpacing([])).toBe(3);
    expect(suggestionSpacing(Array.from({ length: 10 }, () => suggested('skip_next', 4)))).toBe(6);
    expect(suggestionSpacing(Array.from({ length: 10 }, () => suggested('ended', 200)))).toBe(2);
    expect(suggestionSpacing([...Array.from({ length: 5 }, () => suggested('ended', 200)), ...Array.from({ length: 5 }, () => suggested('skip_next', 60))])).toBe(3);
  });

  it('cools a region skipped early twice in a row for the session', () => {
    const facts = library();
    const session = newSession();
    updateSession(session, listen('d0', { endReason: 'skip_next', playedSeconds: 5 }), facts.get('d0'));
    expect(session.coldRegions.has('KOR')).toBe(false);
    updateSession(session, listen('e0', { endReason: 'skip_next', playedSeconds: 5 }), facts.get('e0'));
    expect(session.coldRegions.has('KOR')).toBe(true);
    updateSession(session, listen('d1'), facts.get('d1'));
    expect(session.coldRegions.has('KOR')).toBe(false);
    expect(session.artistPlays.get('d')).toBe(2);
  });
});

describe('Smart Shuffle in the player', () => {
  const track = (id: string): Track => ({
    id, path: `/music/${id}.flac`, fileName: `${id}.flac`, title: id, artist: null, albumArtist: null, album: null, genre: null,
    year: null, trackNumber: null, discNumber: null, duration: 180, codec: 'FLAC', bitrate: null, sampleRate: 44100, bitDepth: 16,
    channels: 2, artwork: null, fileSize: null, lastModified: null, isAvailable: true,
  });

  function setup(ids = ['a', 'b', 'c', 'd']) {
    const engine: any = {
      stateChange$: new BehaviorSubject<any>({ state: 'idle', track: null }), timeUpdate$: new Subject(), volumeChange$: new Subject(),
      outputInterrupted$: new Subject(), subscribeDeviceChanges: () => () => undefined,
      setBackend: vi.fn(async () => undefined), getBackend: () => 'chromium', setOutputMode: vi.fn(async () => undefined),
      setOutputFallbackEnabled: vi.fn(), setVolume: vi.fn(), setMute: vi.fn(), cancelPreparedNext: vi.fn(),
      prepareNext: vi.fn(async () => false), listOutputDevices: async () => [], getAudioPathStatus: async () => null,
      selectOutputDevice: vi.fn(async () => undefined), pause: vi.fn(), play: vi.fn(async () => undefined), dispose: vi.fn(),
      load: vi.fn(async () => undefined), seek: vi.fn(), transitionTo: vi.fn(async () => true),
    };
    const gateway = { getSettings: async () => ({}), saveSettings: vi.fn(async (value: any) => value), saveSession: vi.fn(async () => undefined) };
    const injector = Injector.create({ providers: [{ provide: PLAYBACK_ENGINE, useValue: engine }, { provide: SETTINGS_GATEWAY, useValue: gateway }] });
    const player = runInInjectionContext(injector, () => new PlayerService());
    player.queue.set(ids.map((id, i) => ({ id: `e${i}`, track: track(id), originalIndex: i })));
    player.currentIndex.set(0);
    player.currentTrack.set(track(ids[0]));
    return { player, gateway };
  }
  const ids = (queue: QueueEntry[]) => queue.map((entry) => entry.track.id);

  it('turns shuffle off, and back on turns Smart Shuffle off', async () => {
    const { player, gateway } = setup();
    // Settings load on construction; saving resumes once they are in.
    await new Promise((resolve) => setTimeout(resolve, 0));
    player.toggleShuffle();
    player.setSmartShuffle(true);
    expect(player.isShuffle()).toBe(false);
    expect(player.smartShuffle()).toBe(true);
    expect(gateway.saveSettings).toHaveBeenCalledWith({ smartShuffle: true });
    player.toggleShuffle();
    expect(player.smartShuffle()).toBe(false);
    expect(player.isShuffle()).toBe(true);
  });

  it('cycles the shuffle button Off → Shuffle → Smart Shuffle → Off', () => {
    const { player } = setup();
    const states = [player.shuffleState()];
    for (let i = 0; i < 3; i++) {
      player.cycleShuffle();
      states.push(player.shuffleState());
    }
    expect(states).toEqual(['Off', 'On', 'Smart Shuffle', 'Off']);
  });

  it('drops unplayed suggestions and restores the user order when turned off, keeping the ones heard', () => {
    const { player } = setup();
    player.setSmartShuffle(true);
    const s1 = player.createSuggestedEntry(track('s1'));
    const s2 = player.createSuggestedEntry(track('s2'));
    const queue = player.queue();
    player.replaceUpcoming([queue[2], s1, queue[1], s2, queue[3]]);
    expect(ids(player.queue())).toEqual(['a', 'c', 's1', 'b', 's2', 'd']);
    player.currentIndex.set(2);
    player.setSmartShuffle(false);
    expect(ids(player.queue())).toEqual(['a', 'b', 'c', 's1', 'd']);
    expect(player.currentQueueEntry()?.track.id).toBe('s1');
    expect(player.queue().some((entry) => entry.suggested)).toBe(false);
  });

  it('pins Play next and dragged entries under Smart Shuffle', () => {
    const { player } = setup();
    player.setSmartShuffle(true);
    player.playNext([track('x')]);
    expect(player.queue()[1]).toMatchObject({ pinned: true });
    player.moveQueueEntry('e3', 'e1', 'before');
    expect(player.queue().find((entry) => entry.id === 'e3')).toMatchObject({ pinned: true });
  });

  it('starts from suggestions when nothing is queued', async () => {
    const { player } = setup([]);
    player.currentIndex.set(-1);
    player.setSmartShuffle(true);
    await player.startSuggestions([player.createSuggestedEntry(track('s1')), player.createSuggestedEntry(track('s2'))]);
    expect(ids(player.queue())).toEqual(['s1', 's2']);
    expect(player.currentIndex()).toBe(0);
    expect(player.lastTransition()?.cause).toBe('user');
  });

  it('keeps suggestions across a restart (session version 2)', () => {
    expect(validPlaybackSession({ version: 2, trackIds: [], originalOrder: [], currentIndex: -1, positionSeconds: 0, suggested: [] })).toMatchObject({ version: 2, suggested: [] });
    const id = (n: number) => `track-${String(n).padStart(64, '0')}`;
    const session = { trackIds: [id(1), id(2), id(3)], originalOrder: [0, 2, 1], currentIndex: 0, positionSeconds: 3 };
    expect(validPlaybackSession(session)).toMatchObject({ version: 1 });
    expect(validPlaybackSession({ ...session, suggested: [1] })).toMatchObject({ version: 2, suggested: [1] });
    expect(() => validPlaybackSession({ ...session, suggested: [3] })).toThrow();
    expect(() => validPlaybackSession({ ...session, suggested: [1, 1] })).toThrow();
  });
});
